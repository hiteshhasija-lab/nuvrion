Nuvrion Workstation Agent 0.1.48 (unsigned lab build)

Extract the entire ZIP, then double-click Setup.exe.

Setup supports a new installation or an in-place upgrade. Existing enrollment
and connection settings are preserved during upgrades. Workstation Agent 0.1.48
uses VMware Workstation's native vmcli interface for powered-on VM ISO mount and
eject operations, without keyboard or window automation.

Restart Guest OS uses VMware Tools to request a graceful operating-system reboot.
It remains separate from Reset, which is an immediate hard power cycle.

Only one Workstation Agent process can run at a time. Duplicate scheduled-task,
manual, or orphaned launches exit immediately without starting discovery loops.
Unchanged VM configuration, guest identity, and virtual-disk metadata are cached
for five minutes to reduce repeated disk access and VMware helper launches. Power
state remains monitored every five seconds and incomplete guest data is retried
every minute.

Starting or resuming a VM: Setup (new installs and upgrades) sets "startMode": "gui" in
bootstrap.json, so a VM that is not running, including one resumed from a suspended state,
is started in Workstation and shows in your open Workstation window. An existing "startMode"
is never overwritten. Set "startMode": "nogui" (and restart the agent) to start VMs without a
Workstation window, which is also what the agent does when the setting is absent. The agent
must be running in the signed-in user's desktop session, which is how Setup installs it.
The commands the agent runs against VMware are written to agent.log (agent.vmrun events).

VMware Workstation must be installed. VMware Tools enables native guest hostname,
operating-system, and tools-status reporting for running VMs. CPU usage in MHz
and consumed host memory are measured from each VM's Workstation process.
When native guest metadata is unavailable, the agent resolves hostnames locally
from VMware DHCP leases by VM MAC address; it never substitutes public DNS names.
