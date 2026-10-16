# Connecting providers

A *connection* tells Nuvrion how to reach one provider endpoint. Add one under **Connections > Add connection**.
Credentials are encrypted at rest, write-only (the console never shows them again), and referenced by id.

| Provider | Connection type | Endpoint URL | Credential fields |
|---|---|---|---|
| VMware vSphere / ESXi | Standalone ESXi | `https://<esxi-host>` | username, password |
| VMware vSphere / ESXi | vCenter Server | `https://vcenter.example.com` | username, password |
| VMware Workstation | Workstation REST API | `https://<workstation-host>:8697` | username, password |
| VMware Workstation | Workstation agent | (created by enrolling an agent, see below) | enrollment token |
| Amazon Web Services | Cloud API | `https://ec2.<region>.amazonaws.com` | access key id, secret key, optional session token, **region** |
| Microsoft Azure | Cloud API | `https://management.azure.com` | tenant id, client id, client secret, **subscription id** |

In the form, "Username / access key / client ID" and "Password / secret key / client secret" are the same two inputs
for every provider; the Azure tenant and subscription and the AWS region have their own fields.

## How much each adapter has been proven

Be clear about this before you rely on a provider:

| Provider | Proven against |
|---|---|
| ESXi | A live host in the lab, plus simulated back-ends in tests |
| Workstation (through the agent) | A live Workstation host in the lab |
| vCenter | Simulated back-ends in tests only; no live vCenter has been connected |
| Workstation REST (legacy) | Simulated back-ends in tests only |
| AWS EC2 | Simulated back-ends in tests only; throttling at live AWS has not been exercised |
| Azure VM | Simulated back-ends in tests only; throttling at live Azure has not been exercised |

## Before you add any connection

- **Use an account made for Nuvrion**, not a personal or root account where you can avoid it. It needs to read the
  inventory and perform the actions you intend to use from Nuvrion (power, suspend, snapshots, settings, media). Nuvrion's
  own permissions (`resource.view`, `resource.operate`, `connection.manage`) are separate from the provider's.
- **Reachability and certificates.** The platform must reach the endpoint over HTTPS. For ESXi and vCenter the first
  test records the endpoint's certificate fingerprint and pins it. A later certificate change is refused: the
  fingerprint is compared before any request is sent, and the failure says the certificate does not match the pinned
  fingerprint for the connection. Replace the pin by re-testing the connection after you have confirmed the change.
- **Test, then discover.** After saving, use **Test connection**, then **Discover**. A connection is healthy only when
  its health checks succeed; failures back off and retry on their own and raise an alert, which recovers by itself.

## VMware ESXi and vCenter

1. Create a user on the host (or a vCenter user) for Nuvrion.
2. Provider: *VMware vSphere / ESXi*; connection type: *Standalone ESXi* or *vCenter Server*; endpoint is the host
   or vCenter URL with no path.
3. Save, **Test connection**, **Discover**.

Common outcomes (the code is in the error, and it is what the alert and task result show):

| Code | Meaning | What to do |
|---|---|---|
| `NUV_ESXI_AUTH_FAILED` | Wrong user name or password | Fix the credential. Not retried, so a wrong password is not repeated against the host |
| `NUV_ESXI_PERMISSION_DENIED` | The account lacks the privilege | Grant it; not retried |
| `NUV_ESXI_UNREACHABLE` | The host did not answer (powered off, network, firewall) | Retried with backoff; raises an alert that recovers by itself |
| `NUV_ESXI_UNAVAILABLE` | The host answered with a server error | Retried with backoff |
| `NUV_PROVIDER_RESPONSE_TOO_LARGE` | A VMware endpoint sent a reply over 64 MB (a real reply is a few MB at most), so Nuvrion stopped reading it | Not retried. Check that the address points at ESXi or vCenter and not at something else; a datastore listing that is too large is reported as a warning and the rest of the inventory is kept |
| `NUV_ESXI_GUEST_TOOLS_UNAVAILABLE` | A guest shutdown or restart needs VMware Tools running in the guest | Not retried. Start the guest's Tools, or use **Power off** to force it |
| `NUV_ESXI_RESOURCE_NOT_FOUND` | The VM is no longer on the host | Run discovery; the VM is shown as missing |

## VMware Workstation

Two ways, and the **agent is the supported one**: the Workstation REST API (`vmrest`) cannot report everything the
agent can.

### Through the Nuvrion Workstation agent

The agent runs on the Windows machine that hosts Workstation and talks to the platform over HTTPS. See
[workstation-agent.md](workstation-agent.md) for installing it. In short: create a single-use enrollment token (valid
10 minutes; `POST /api/v1/agents/enrollment-tokens`, which needs the `platform.manage` permission), run the agent's
`Setup.exe`, give it the platform URL and the token, and the Workstation connection appears.

### Through the Workstation REST API

Enable VMware's own REST service on the Workstation host (`vmrest -C` sets its credential; the service listens on
port 8697 over HTTPS), then add a connection of type *Workstation REST API* with that URL and credential.

## Amazon Web Services

1. Create an IAM user or role for Nuvrion with permission to describe and start/stop/reboot EC2 instances in the
   regions you will use.
2. Provider: *Amazon Web Services*; connection type: *Cloud API*; endpoint `https://ec2.<region>.amazonaws.com`;
   **Region** is required (`NUV_AWS_REGION_REQUIRED` otherwise); put the access key id and secret key in the credential
   fields. A session token is optional (for temporary credentials).

| Code | Meaning |
|---|---|
| `NUV_AWS_AUTH_FAILED` | The key is wrong, expired or revoked |
| `NUV_AWS_PERMISSION_DENIED` | The key is valid but not allowed this action |
| `NUV_AWS_RESOURCE_NOT_FOUND` | The instance no longer exists |
| `NUV_AWS_THROTTLED` | AWS is rate limiting; retried with backoff |
| `NUV_AWS_UNAVAILABLE` | AWS answered with a server error; retried with backoff |
| `NUV_AWS_VERIFICATION_TIMEOUT` | The operation was accepted but did not reach the expected state in time; retried |
| `NUV_AWS_REQUEST_FAILED` | Any other failure; retried only when AWS marks it retryable |

## Microsoft Azure

1. Create an app registration (service principal) and give it a role that can read and operate VMs in the subscription.
2. Provider: *Microsoft Azure*; connection type: *Cloud API*; fill **Azure tenant ID**, **Azure subscription ID**,
   client id in the user field and the client secret in the password field.

| Code | Meaning |
|---|---|
| `NUV_AZURE_CREDENTIAL_REQUIRED` | Tenant id, client id or client secret is missing |
| `NUV_AZURE_SUBSCRIPTION_REQUIRED` | No subscription id |
| `NUV_AZURE_AUTH_FAILED` | The secret is wrong or expired |
| `NUV_AZURE_PERMISSION_DENIED` | The principal lacks a role on the subscription |
| `NUV_AZURE_THROTTLED` | Azure is rate limiting; retried with backoff |

## Rotating or removing a connection

Editing a connection and saving a new password replaces the stored credential; the old value is not recoverable from
the console. Deleting a connection marks its VMs missing (they are not deleted from the provider).
