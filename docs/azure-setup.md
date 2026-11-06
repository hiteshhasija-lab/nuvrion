# Microsoft Azure: permissions, setup and troubleshooting

This guide covers the least-privilege role Nuvrion needs for Azure virtual machines, how to create the service principal it
signs in with, how to connect it, and what the errors mean. For the other providers, and the table of how much each adapter
has been proven, see [connecting-providers.md](connecting-providers.md).

> **Status: written from the code, not yet run against a real Azure subscription.** The permission list below is exactly the
> set of Azure Compute calls the adapter makes (a test fails if the adapter gains a call that this guide does not list), and
> the adapter is tested against a fake client. It has never signed in to Azure, and the sign-in library pairing is itself
> unproven (see [security-analysis.md](security-analysis.md), "Dependency override"). The first live connection is the real
> validation: follow [Verify the role before you connect](#verify-the-role-before-you-connect) and report anything that differs.

## What Nuvrion does in Azure

| Nuvrion does | Compute operation | Azure RBAC action |
|---|---|---|
| Test the connection | list virtual machines in the subscription (first result only) | `Microsoft.Compute/virtualMachines/read` |
| Discover machines | list all virtual machines in the subscription, then read each one's instance view (one extra request per machine) | `Microsoft.Compute/virtualMachines/read`, `Microsoft.Compute/virtualMachines/instanceView/read` |
| Start | start the machine and wait for it to finish | `Microsoft.Compute/virtualMachines/start/action` |
| Stop | **deallocate** the machine and wait | `Microsoft.Compute/virtualMachines/deallocate/action` |
| Restart | restart the machine and wait | `Microsoft.Compute/virtualMachines/restart/action` |
| Follow the long-running operation to its end | poll the operation's status | `Microsoft.Compute/locations/operations/read` |
| Check the final power state | read the instance view | `Microsoft.Compute/virtualMachines/instanceView/read` |

That is all. Nuvrion does not create, delete, resize or tag machines, does not read disks, networks, images or costs, and
does not call any service other than Azure Compute. Suspend, force power-off, snapshots and media are not offered for Azure
machines. Tags that Azure reports are shown read-only in Nuvrion; nothing is written back.

**Stop means deallocate**, not "stop but keep the allocation": the machine stops billing for compute, and a dynamic public
address and any temporary disk contents are released, as with any Azure deallocate.

## The role

Two choices.

**Read-only:** assign the built-in **Reader** role on the subscription. Discovery, the inventory and alerts work; Start, Stop
and Restart fail with `NUV_AZURE_PERMISSION_DENIED`, which is not retried.

**Read and operate:** create the custom role [policies/azure-nuvrion-role.json](policies/azure-nuvrion-role.json). The built-in
*Virtual Machine Contributor* role also works but allows creating, resizing and deleting machines, which Nuvrion never does.

```json
{
  "Name": "Nuvrion VM Operator",
  "IsCustom": true,
  "Description": "Lets Nuvrion list virtual machines, read their power state, and start, deallocate and restart them. Nothing else.",
  "Actions": [
    "Microsoft.Compute/virtualMachines/read",
    "Microsoft.Compute/virtualMachines/instanceView/read",
    "Microsoft.Compute/virtualMachines/start/action",
    "Microsoft.Compute/virtualMachines/deallocate/action",
    "Microsoft.Compute/virtualMachines/restart/action",
    "Microsoft.Compute/locations/operations/read"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": [],
  "AssignableScopes": [
    "/subscriptions/<subscription-id>"
  ]
}
```

`Microsoft.Compute/locations/operations/read` is included because the start, deallocate and restart calls poll an operation
until it completes; the built-in Contributor roles carry it. Whether a role without it would be refused has not been tested.

### Narrowing the scope

Nuvrion discovers by listing **the whole subscription**. Assigning the role on a single resource group or machine therefore
makes the subscription-wide list fail with `NUV_AZURE_PERMISSION_DENIED` even though operations on those machines would be
allowed. Assign the role at the **subscription** and, if you need to limit what Nuvrion may operate, use one subscription
for the machines Nuvrion manages.

## Create the service principal

With the Azure CLI (as someone who can create app registrations and role definitions):

```bash
az login
az account set --subscription <subscription-id>
# edit docs/policies/azure-nuvrion-role.json first: replace <subscription-id>
az role definition create --role-definition docs/policies/azure-nuvrion-role.json
az ad sp create-for-rbac --name nuvrion --role "Nuvrion VM Operator" --scopes /subscriptions/<subscription-id>
```

The last command prints `appId` (the **client ID**), `password` (the **client secret**, shown once) and `tenant` (the
**tenant ID**). Current CLI versions give the secret a lifetime of one year; check the date with
`az ad app credential list --id <appId>` and put it in your calendar. For the read-only choice use `--role Reader`.

In the portal the same steps are: Microsoft Entra ID, App registrations, New registration (single tenant, no redirect URI);
Certificates & secrets, New client secret (copy the **value**, not the secret id); Subscriptions, your subscription, Access
control (IAM), Add role assignment, choose the role, select the app.

Also check that the **Microsoft.Compute** resource provider is registered in the subscription (it is by default wherever
virtual machines already exist).

## Verify the role before you connect

Sign in as the new principal and try what Nuvrion will do. Use a machine you can afford to restart:

```bash
az login --service-principal -u <appId> -p <client-secret> --tenant <tenant-id>
az vm list --query "[].name" -o tsv
az vm get-instance-view --ids <vm-resource-id> --query "instanceView.statuses[].code" -o tsv
az vm restart --ids <vm-resource-id>
```

`vm list` and `get-instance-view` need the read actions; `vm restart` needs the restart action. A `AuthorizationFailed`
message names the action that is missing: add it to the role, or fix the assignment scope.

## Add the connection

1. **Connections > Add connection**.
2. Provider **Microsoft Azure**, connection type **Cloud API**.
3. **Endpoint**: leave empty, or `https://management.azure.com` for the public cloud.
4. **Azure tenant ID** and **Azure subscription ID**.
5. **Client ID** in the user field and the **client secret** in the password field.
6. Save, then **Test connection**, then **Discover**.

The secret is encrypted when saved and is never shown again. To rotate it, create a new secret on the app registration, edit
the connection and enter it, then delete the old secret in Azure. One connection covers **one subscription** (every resource
group in it); add one connection per subscription.

What you will see after discovery: the machine name, power state (running, stopped for a deallocated machine, starting,
stopping, restarting), health from the provisioning state (healthy when it succeeded, critical when it failed), size, region,
availability zone, operating system, total disk size (operating-system disk plus data disks) and tags.
**Virtual CPU count, memory and network addresses are not shown** for Azure machines.

## What happens on a power action

Start, Stop (deallocate) and Restart are long-running Azure operations; Nuvrion waits for them to finish and then reads the
instance view to confirm the machine is `running` or stopped before recording the verified result. If the state is not yet
the expected one the task is marked `NUV_AZURE_VERIFICATION_PENDING` and is retried; if the process dies after Azure accepted
the request, the task goes to *verification required* and the operation is never sent a second time.

## Troubleshooting

| Code | Meaning | What to do |
|---|---|---|
| `NUV_AZURE_CREDENTIAL_REQUIRED` | Tenant ID, client ID or client secret is missing | Edit the connection and fill all three |
| `NUV_AZURE_SUBSCRIPTION_REQUIRED` | No subscription ID | Fill **Azure subscription ID** |
| `NUV_AZURE_AUTH_FAILED` | Azure rejected the sign-in or the token (HTTP 401) | Check the secret has not expired or been deleted, and that the tenant and client IDs belong together. Not retried |
| `NUV_AZURE_PERMISSION_DENIED` | The principal lacks a role on the subscription (HTTP 403, `AuthorizationFailed`) | The message names the missing action; add it, or assign the role at the subscription. Not retried |
| `NUV_AZURE_RESOURCE_NOT_FOUND` | The machine, or the subscription, is not found | Run discovery; a removed machine is marked missing. If every call fails, check the subscription ID |
| `NUV_AZURE_THROTTLED` | Azure is limiting the request rate | Retried with backoff. Discovery makes one request per machine, so a very large subscription is the likely cause |
| `NUV_AZURE_UNAVAILABLE` | Azure answered with a server error or timed out | Retried with backoff; raises an alert that recovers by itself |
| `NUV_AZURE_VERIFICATION_PENDING` | The operation finished but the machine has not yet reported the expected state | Retried |
| `NUV_AZURE_RESOURCE_ID_INVALID` | The machine's Azure resource id has an unexpected form | Run discovery again; report it if it persists |
| `NUV_AZURE_REQUEST_FAILED` | Any other failure, with Azure's own message | Read the message |

A wrong or expired secret is expected to show as `NUV_AZURE_AUTH_FAILED`. The sign-in library reports its own error type
for a failed token request, and the mapping has never run against real Azure, so you may instead see
`NUV_AZURE_REQUEST_FAILED` with the library's message (for example, that the secret has expired). Treat either as "check the
secret first".

## Limits to know about

- Public Azure only. The adapter signs in at the public Microsoft Entra authority and does not set an authority host, so
  Azure China, Azure Government and other sovereign clouds will not authenticate even if you set a different endpoint.
- Sign-in uses a client secret. Certificates, managed identities and workload identity federation are not supported.
- Discovery reads each machine's instance view separately, so time and request count grow with the number of machines. No
  live throttling test has been run against Azure.
- Scale sets, disks, networks, addresses and costs are not modelled.
