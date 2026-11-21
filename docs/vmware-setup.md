# VMware: setup, permissions and troubleshooting

This guide covers connecting Nuvrion to VMware: a standalone **ESXi** host, a **vCenter Server**, and **VMware Workstation**.
It says which account to create and what it needs, how to check that before connecting, how the connection is secured,
what Nuvrion does on a power action, and what each error means. For the other providers, and the table of how much each
adapter has been proven, see [connecting-providers.md](connecting-providers.md); for Workstation agents in depth, see
[workstation-agent.md](workstation-agent.md).

## What has been proven

| | Proven against |
|---|---|
| ESXi 7.0 and 8.0.3 (standalone) | Live hosts in the lab, and simulated back-ends in tests |
| Workstation through the Nuvrion agent | A live Workstation host in the lab (Windows) |
| vCenter Server | **Simulated back-ends in tests only. No live vCenter has been connected** |
| Workstation REST API (`vmrest`) | Simulated back-ends in tests only |

> **The privilege list below comes from the code, not from a restricted account.** It is the set of vSphere calls the
> adapters make, matched to the privileges VMware documents for them, and a test fails if an adapter gains a call this guide
> does not list. Nobody has yet run Nuvrion with an account limited to this list, so if an action is refused for a reason
> that is not listed here, trust the host's message and tell us. The guide has not been followed on a clean setup by a
> second person.

## Choosing a connection type

| You have | Use | Endpoint | Credential |
|---|---|---|---|
| One ESXi host | **Standalone ESXi** | `https://<esxi-host>` | A local user on the host |
| vCenter Server | **vCenter Server** | `https://<vcenter>` | A vCenter user, for example `nuvrion@vsphere.local` |
| Workstation on Windows | **Workstation agent** (recommended) | Created by enrolling the agent | A single-use enrollment token |
| Workstation, REST only | **Workstation REST API** | `https://<host>:8697` | The `vmrest` user |

Give the endpoint with no path. Nuvrion's own permissions (`resource.view`, `resource.operate`, `connection.manage`,
`platform.manage`) are separate from the VMware account's: a person needs both for an action to work.

## What Nuvrion does on ESXi and vCenter

| Nuvrion does | ESXi (SOAP `/sdk`) | vCenter (REST `/api`, SOAP for snapshots and settings) | Privilege group |
|---|---|---|---|
| Sign in and out for every operation | `RetrieveServiceContent`, `Login`, `Logout` | `/api/session` | read |
| Test the connection, discover VMs, hosts, datastores, networks | `CreateContainerView`, `RetrievePropertiesEx`, `ContinueRetrievePropertiesEx` | `/api/vcenter/vm`, `/api/vcenter/vm/{id}`, `/api/vcenter/vm/{id}/tools`, `/api/vcenter/vm/{id}/guest/identity`, `/api/vcenter/datacenter`, `/api/vcenter/datastore` (clusters, hosts and networks through the same `/api/vcenter/` listings) | read |
| Start, power off, restart, suspend | `PowerOnVM_Task`, `PowerOffVM_Task`, `ResetVM_Task`, `SuspendVM_Task` | `/api/vcenter/vm/{id}/power` | power |
| Stop (guest shutdown), guest restart | `ShutdownGuest`, `RebootGuest` | `/api/vcenter/vm/{id}/guest/power` | power |
| Open a VM console | `AcquireTicket` (WebMKS) | `/api/vcenter/vm/{id}/console/tickets` | console |
| List drives, mount and eject an ISO | `ReconfigVM_Task`, and an HTTPS read of `/folder` on the host to find ISO files | `/api/vcenter/vm/{id}/hardware/cdrom`, `/api/vcenter/vm/{id}/hardware/cdrom/{id}` | media |
| Create, revert, delete a snapshot | `CreateSnapshot_Task`, `RevertToSnapshot_Task`, `RemoveSnapshot_Task` | the same SOAP calls against vCenter | snapshots |
| Read and edit VM settings (CPU, memory, disks, network adapters, CD, boot, advanced options) | `ReconfigVM_Task`, `QueryConfigTarget` | the same SOAP calls against vCenter | settings |

That is all. Nuvrion does not create, clone, migrate or delete VMs, does not change host or datastore configuration and
does not touch vCenter inventory.

## The privileges

[policies/vmware-nuvrion-privileges.json](policies/vmware-nuvrion-privileges.json) holds the list as data. Grant only the
groups for what Nuvrion should do:

| Group | vSphere privileges | Lets Nuvrion |
|---|---|---|
| read | `System.Anonymous`, `System.View`, `System.Read` (vSphere adds these to every role) | discover and read everything above. A **read-only** account is the built-in *Read-only* role |
| power | `VirtualMachine.Interact.PowerOn`, `VirtualMachine.Interact.PowerOff`, `VirtualMachine.Interact.Reset`, `VirtualMachine.Interact.Suspend` | start, stop, power off, restart, guest restart, suspend |
| console | `VirtualMachine.Interact.ConsoleInteract` | open a VM console |
| media | `VirtualMachine.Interact.SetCDMedia`, `VirtualMachine.Interact.DeviceConnection`, `Datastore.Browse` | list ISO files and mount or eject them |
| snapshots | `VirtualMachine.State.CreateSnapshot`, `VirtualMachine.State.RevertToSnapshot`, `VirtualMachine.State.RemoveSnapshot` | create, revert and delete snapshots |
| settings | `VirtualMachine.Config.CPUCount`, `VirtualMachine.Config.Memory`, `VirtualMachine.Config.Resource`, `VirtualMachine.Config.Settings`, `VirtualMachine.Config.AdvancedConfig`, `VirtualMachine.Config.AddRemoveDevice`, `VirtualMachine.Config.EditDevice`, `VirtualMachine.Config.Rename`, `VirtualMachine.Config.Annotation`, `Datastore.AllocateSpace`, `Network.Assign` | edit a VM's settings |

Without a group the feature simply fails with a permission error and is not retried. Grant **power** at least if you want
Nuvrion to operate machines.

## Standalone ESXi

### Create the account

1. Open the **Host Client** (`https://<esxi-host>/ui`) as `root`.
2. **Manage > Security & users > Roles > Add role**: name it `Nuvrion`, tick the privileges of the groups you want.
3. **Manage > Security & users > Users > Add user**: a name such as `nuvrion` and a long, unique password.
4. **Host > Actions > Permissions > Add user**: the new user with the `Nuvrion` role, and keep *Propagate to all children*
   ticked so that it applies to every VM.

For read-only use, give the user the built-in *Read-only* role in step 4 instead and skip step 2.

### Check it before you connect

From any machine that can reach the host, check that the API answers, then sign in to the Host Client **as the new user**
and try the actions you intend to use (power on a spare VM, open its console, mount an ISO). An action that is refused here
will be refused by Nuvrion.

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://<esxi-host>/sdk/vimServiceVersions.xml
```

`200` means the host's API answers.

### Add the connection

1. **Connections > Add connection**.
2. Provider **VMware vSphere / ESXi**, connection type **Standalone ESXi**, endpoint `https://<esxi-host>`.
3. The user name and password of the new account.
4. Save, then **Test connection**, then **Discover**.

The password is encrypted when saved and is never shown again. To rotate it, edit the connection and enter the new one.

### Certificate and SSH host-key pinning

The first test records the host's TLS certificate fingerprint and, if the SSH service answers on port 22, its SSH host-key
fingerprint, and keeps them with the connection. From then on:

- every request is refused **before it is sent** if the certificate presented does not match the pin. The message says that
  the certificate does not match the pinned fingerprint for the connection. This is what you see after a host is rebuilt or
  its certificate is replaced;
- to see what a host presents now, and compare it with what you expect:

  ```bash
  openssl s_client -connect <esxi-host>:443 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
  ```

- after you have confirmed the change was intended, re-test the connection to replace the pin;
- the **host terminal** needs the SSH pin. If SSH was off at the first test there is none, and a terminal is refused with
  `NUV_SSH_HOST_KEY_REQUIRED` until SSH is on and the connection has been tested again. The terminal asks for an SSH user
  and password each time; Nuvrion does not store them.

### The console, host client and terminal

- **Console**: Nuvrion asks the host for a WebMKS ticket (valid about five minutes) and proxies the browser to it; every
  console session is audited.
- **Host Client**: opens `https://<esxi-host>/ui` for standalone ESXi connections only (needs `resource.operate`); audited.
- **Host terminal**: an SSH session to the host, standalone ESXi only, needs the Nuvrion permission `platform.manage`, the
  SSH service enabled on the host, and a user and password typed at use; audited.

### Licence

A host running the free ESXi licence may refuse changes through the API (power operations, snapshots, settings) while
reads still work. If every action fails but discovery works, read the message in the task result before looking at
privileges. The lab hosts accept changes; this is reported by VMware's own message, not classified by Nuvrion.

## vCenter Server

> **Never run live.** Everything here is written from the adapter's code and tested against simulated back-ends.

### Create the account

1. In the vSphere Client: **Administration > Access Control > Roles > Add**: name it `Nuvrion`, tick the privileges of the
   groups you want.
2. **Administration > Single Sign On > Users and Groups > Users > Add**: for example `nuvrion` in `vsphere.local`.
3. On the **vCenter root object** (right-click it > **Add Permission**): the user, the role, and **Propagate to children**.
   A permission on a single folder, cluster or host limits what Nuvrion can see, and discovery lists the whole vCenter, so
   assign it at the root unless you want a partial view.

The user name for the connection is the full SSO name, for example `nuvrion@vsphere.local`.

### Check it before you connect

The adapter needs the vCenter REST API under `/api` (vCenter 7.0 Update 2 and later, to our knowledge; no vCenter has been
tried), so check that the account can open a session. curl asks for the password:

```bash
curl -sk -u 'nuvrion@vsphere.local' -X POST https://<vcenter>/api/session -w '\n%{http_code}\n'
```

`201` and a token mean the account can sign in. Then sign in to the vSphere Client as the new user and try the actions.

### Add the connection

**Connections > Add connection**, provider **VMware vSphere / ESXi**, connection type **vCenter Server**, endpoint
`https://<vcenter>`, the SSO user and password. Save, **Test connection**, **Discover**. Datacenters, clusters, hosts,
datastores and networks are discovered and shown on the Infrastructure page. The host client and terminal are not offered
for vCenter connections.

**Certificates.** Pinning (above) is recorded for standalone ESXi connections only. For vCenter, Nuvrion checks the
certificate the ordinary way, against the certificate authorities the platform's container trusts. A vCenter that still
uses its default VMCA-signed certificate is therefore expected to fail until the platform trusts that CA, and the failure
would show as `NUV_VMWARE_UNREACHABLE` with a certificate message. This has not been seen, because no vCenter has been
connected; give vCenter a certificate from a CA the platform trusts, or ask us to extend pinning to vCenter.

## VMware Workstation

### Through the Nuvrion Workstation agent (supported)

The agent runs on the Windows machine that hosts Workstation and connects **out** to the platform over HTTPS. Create a
single-use enrollment token in the platform (valid 10 minutes, permission `platform.manage`), run the agent's `Setup.exe`
with the platform URL and the token, and the connection appears. Everything about installing, checking
(`verify-install.ps1`), `startMode`, upgrades from the console and troubleshooting is in
[workstation-agent.md](workstation-agent.md). The agent needs the desktop session of a signed-in user.

### Through the Workstation REST API (legacy)

Enable VMware's REST service (`vmrest -C` sets its credential; it listens on port 8697 over HTTPS), then add a connection
of type **Workstation REST API** with that URL and credential. It cannot report everything the agent can, and it has only
been tested against a simulated back-end.

## What happens on a power action

| In Nuvrion | On ESXi | On vCenter | Notes |
|---|---|---|---|
| Start | `PowerOnVM_Task` | power `start` | |
| Stop | `ShutdownGuest` | guest power `shutdown` | A **guest** shutdown: needs VMware Tools running. Without it: `NUV_ESXI_GUEST_TOOLS_UNAVAILABLE`, not retried |
| Power off | `PowerOffVM_Task` | power `stop` | **Forced**, like pulling the plug |
| Restart | `ResetVM_Task` | power `reset` | A **hard reset**, not a guest restart |
| Guest restart | `RebootGuest` | guest power `reboot` | Needs VMware Tools; Nuvrion confirms the guest really restarted |
| Suspend | `SuspendVM_Task` | power `suspend` | |

Every operation is a task: Nuvrion asks for it, then checks the VM's real state before recording the result as verified. If
the host does not reach the expected state in time the task goes to *verification required* and is **never sent a second
time**. The connection's `timeoutMs` (default 15 s per request), `verificationAttempts` (90) and `verificationIntervalMs`
(500 ms) can be set in the connection's configuration.

## Troubleshooting

Codes are in the alert, the task result and the audit log. ESXi connections use `NUV_ESXI_…`, vCenter `NUV_VMWARE_…`.

| Code | Meaning | What to do |
|---|---|---|
| `NUV_ESXI_AUTH_FAILED` / `NUV_VMWARE_AUTH_FAILED` | Wrong user name or password | Fix the credential. Not retried, so a wrong password is not repeated against the host |
| `NUV_ESXI_PERMISSION_DENIED` / `NUV_VMWARE_PERMISSION_DENIED` | The account lacks a privilege, or the permission does not reach the VM | Compare with the table above; check *Propagate*; look at the host's or vCenter's task and event list for the privilege it names. Not retried |
| `NUV_ESXI_UNREACHABLE` / `NUV_VMWARE_UNREACHABLE` | No answer (host off, network, firewall, port 443; for vCenter also an untrusted certificate) | Retried with backoff; an alert opens and recovers by itself |
| `NUV_ESXI_UNAVAILABLE` / `NUV_VMWARE_UNAVAILABLE` | The host answered with a server error | Retried with backoff |
| `NUV_ESXI_RESOURCE_NOT_FOUND` / `NUV_VMWARE_RESOURCE_NOT_FOUND` | The VM is gone | Run discovery; it is marked missing |
| `NUV_ESXI_GUEST_TOOLS_UNAVAILABLE` | Guest shutdown or restart without VMware Tools | Start Tools in the guest, or use Power off |
| `NUV_ESXI_TASK_FAILED`, `NUV_ESXI_VERIFICATION_TIMEOUT`, `NUV_VMWARE_VERIFICATION_TIMEOUT` | VMware accepted the request but the task failed or the state was not reached in time | Read VMware's message; the task goes to verification and is not repeated |
| `NUV_ESXI_HOST_IDENTITY_UNAVAILABLE` | The host did not return its name | Retried |
| `NUV_ESXI_REQUEST_FAILED` / `NUV_VMWARE_REQUEST_FAILED` | Any other failure, with VMware's own message | Read the message |
| `NUV_ESXI_REFERENCE_INVALID` / `NUV_VMWARE_REFERENCE_INVALID` / `NUV_WORKSTATION_REFERENCE_INVALID` / `NUV_AGENT_REFERENCE_INVALID` | The platform no longer holds the operation it was asked to confirm (for example after the API restarted); the operation is not sent again | Run discovery; the task shows *verification required* |
| `NUV_OPERATION_UNSUPPORTED` | This provider does not offer that operation | Use one it offers |
| `NUV_ESXI_PROTOCOL_ERROR` | The endpoint is not answering as vSphere does | Check the address points at ESXi, not at a proxy or another service |
| `NUV_PROVIDER_RESPONSE_TOO_LARGE` | A reply over 64 MB (a real reply is a few MB) | Not retried. Check the address; a datastore listing that is too large is a warning and the rest is kept |
| (message) certificate does not match the pinned fingerprint | A standalone ESXi host's certificate changed | See *Certificate and SSH host-key pinning* |
| `NUV_VMWARE_TLS_REQUIRED` | The endpoint is not HTTPS | Use an `https://` address |
| `NUV_SSH_HOST_KEY_REQUIRED` | No SSH pin for the host terminal | Enable SSH on the host and test the connection again |
| `NUV_CONSOLE_TICKET_INVALID`, `NUV_CONSOLE_UNSUPPORTED` | No console ticket was returned, or the provider has no console | Check the `console` privilege and that the VM is powered on |
| `NUV_SNAPSHOT_PERMISSION_DENIED`, `NUV_SNAPSHOT_AUTH_FAILED` | The account may not snapshot | Grant the *snapshots* group |
| `NUV_SNAPSHOT_STATE_CONFLICT`, `NUV_SNAPSHOT_HAS_CHILDREN`, `NUV_SNAPSHOT_NOT_FOUND`, `NUV_SNAPSHOT_OPERATION_IN_PROGRESS` | The snapshot or the VM is not in a state that allows this | Refresh; wait for the running operation |
| `NUV_SNAPSHOT_TASK_FAILED`, `NUV_SNAPSHOT_VERIFICATION_TIMEOUT`, `NUV_SNAPSHOT_UNSUPPORTED` | VMware failed the task, the result was not confirmed, or the provider cannot snapshot | Read VMware's message |
| `NUV_SNAPSHOT_PROVIDER_UNREACHABLE`, `NUV_SNAPSHOT_PROVIDER_FAILED`, `NUV_SNAPSHOT_PROTOCOL_ERROR` | The host did not answer, failed, or answered unexpectedly during a snapshot | Retry; check the address and the host |
| `NUV_MEDIA_PATH_INVALID`, `NUV_MEDIA_REQUEST_INVALID`, `NUV_MEDIA_DRIVE_NOT_FOUND` | The ISO path (`[datastore1] images/server.iso`) or drive is wrong | Choose from the list; paths with `..` are refused |
| `NUV_MEDIA_BROWSE_PERMISSION_DENIED`, `NUV_MEDIA_BROWSE_FAILED`, `NUV_MEDIA_BROWSE_TIMEOUT`, `NUV_MEDIA_BROWSE_UNREACHABLE`, `NUV_MEDIA_BROWSE_PATH_INVALID`, `NUV_MEDIA_BROWSE_LIMIT` | Nuvrion could not read a datastore | Grant `Datastore.Browse`. Browsing stops after 80 folders per datastore and 500 images (`NUV_MEDIA_BROWSE_LIMIT`); each is a warning and the rest of the inventory is kept |
| `NUV_MEDIA_VM_NOT_FOUND`, `NUV_MEDIA_CONFIRMATION_REQUIRED` | The VM is gone, or the change needs a confirmation the request did not carry | Run discovery; confirm in the dialog |
| `NUV_MEDIA_VERIFICATION_TIMEOUT`, `NUV_MEDIA_VERIFICATION_FAILED`, `NUV_MEDIA_OPERATION_IN_PROGRESS`, `NUV_MEDIA_RECONFIGURE_FAILED` | The mount or eject was not confirmed, or another change is running | Check the VM's CD drive in the host's own client |
| `NUV_VM_SETTINGS_PERMISSION_DENIED`, `NUV_VM_SETTINGS_AUTH_FAILED` | The account may not reconfigure | Grant the *settings* group |
| `NUV_VM_SETTINGS_STATE_CONFLICT`, `NUV_VM_SETTINGS_IN_PROGRESS`, `NUV_VM_SETTINGS_DEVICE_NOT_FOUND`, `NUV_VM_SETTINGS_DEVICE_NOT_REMOVABLE`, `NUV_VM_SETTINGS_CONTROLLER_REQUIRED`, `NUV_VM_SETTINGS_DISK_SHRINK_UNSUPPORTED`, `NUV_VM_SETTINGS_UNSUPPORTED` | The VM's state or hardware does not allow the change (a disk cannot shrink; some changes need the VM off) | Read the message; change the VM's state first |
| `NUV_VM_SETTINGS_TASK_FAILED`, `NUV_VM_SETTINGS_TIMEOUT`, `NUV_VM_SETTINGS_UNREACHABLE`, `NUV_VM_SETTINGS_PROVIDER_FAILED`, `NUV_VM_SETTINGS_PROTOCOL_ERROR` | VMware failed the reconfiguration, or did not answer | Read VMware's message |
| `NUV_AGENT_OFFLINE`, `NUV_AGENT_NOT_FOUND`, `NUV_AGENT_COMMAND_FAILED` | A Workstation agent is not connected, is unknown, or a command failed | [workstation-agent.md](workstation-agent.md) |
| `NUV_AGENT_UPGRADE_REQUIRED`, `NUV_AGENT_MEDIA_UPGRADE_REQUIRED`, `NUV_AGENT_MEDIA_BROWSE_UPGRADE_REQUIRED`, `NUV_AGENT_GUEST_RESTART_UPGRADE_REQUIRED` | The installed agent is too old for the feature | Upgrade the agent from the console |
| `NUV_AGENT_REGISTRY_UNAVAILABLE`, `NUV_AGENT_VERIFICATION_TIMEOUT` | The platform cannot reach its agent records, or the agent did not confirm in time | Retry; check the agent is online |
| `NUV_WORKSTATION_AUTH_FAILED`, `NUV_WORKSTATION_PERMISSION_DENIED`, `NUV_WORKSTATION_UNREACHABLE`, `NUV_WORKSTATION_UNAVAILABLE`, `NUV_WORKSTATION_STATE_CONFLICT`, `NUV_WORKSTATION_RESOURCE_NOT_FOUND`, `NUV_WORKSTATION_VERIFICATION_PENDING`, `NUV_WORKSTATION_REQUEST_FAILED` | The legacy Workstation REST connection: wrong credential, not allowed, not answering, a VM state that does not allow the operation, a VM that is gone, or any other failure | Check `vmrest` is running and its credential; the first four are the same kinds of fault as for ESXi |

## Limits to know about

- vCenter has never been connected; the privilege list has never been exercised with a restricted account.
- A standalone ESXi connection covers one host. For several hosts, add one connection each, or use vCenter.
- Resource pools are not modelled. Clone, migrate, disk and network management of the host are not offered.
- Workstation has no snapshots in Nuvrion; there is no host-resource reporting for it.
- The ISO browser reads datastores over the host's HTTPS `/folder` listing, not through the API.
