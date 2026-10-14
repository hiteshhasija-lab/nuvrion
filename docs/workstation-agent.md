# The Workstation agent

The agent is a small Windows program (`nuvrion-workstation-agent.exe`) that runs next to VMware Workstation and gives
Nuvrion what the Workstation REST service cannot: power state, guest details, console, media, and signed commands. It
connects **out** to the platform over HTTPS; nothing connects in.

## Install

1. In the platform, create a single-use enrollment token (valid 10 minutes): `POST /api/v1/agents/enrollment-tokens`
   (permission `platform.manage`).
2. Extract the whole agent ZIP on the Windows machine, then run `Setup.exe`. It asks for the platform URL, the token,
   and the folders the agent may search for VMs and ISO images, and installs the agent as a scheduled task that runs
   in your signed-in desktop session (it needs the desktop to open VMs in Workstation).
3. The Workstation connection appears in the console and the agent shows as online.

Setup is also the **upgrade** path: run the newer `Setup.exe` over an existing install. Enrollment and settings are
preserved, and an existing `startMode` is never overwritten.

## Files (next to the executable, normally `C:\Program Files\Nuvrion\WorkstationAgent`)

| File | What it is |
|---|---|
| `bootstrap.json` | Configuration. **Contains the agent's identity secret**: do not copy or paste it |
| `agent.log` | JSON lines; rotated at 2 MB |
| `command-journal.json` | Commands already run (kept 7 days), so a redelivered command is answered, not repeated |
| `paused-vms.json` | VMs the agent paused |

The agent reads `bootstrap.json` **only at startup**: restart the scheduled task after editing it.

## Verify an installation

After a clean install or an upgrade, run the read-only verifier (copy `deploy/workstation-agent/verify-install.ps1`
from the repository to the machine) in PowerShell:

```powershell
.\verify-install.ps1
```

It prints one PASS or FAIL line per check and exits 0 only if all pass: the files are present, `bootstrap.json` is valid
and points at an HTTPS platform URL, `vmrun` runs, the agent is enrolled and its single-use token was consumed,
`startMode` is set, the scheduled task exists and is enabled, exactly one agent process runs in a desktop session and
started after the last edit of `bootstrap.json`, and `agent.log` shows inventory being published in the last few
minutes without a fatal error. It changes nothing and never prints the agent's secret. Run it on a machine that did not
build the agent to give a clean-install result that does not depend on the author.

## Starting and resuming VMs: `startMode`

By default a VM that is not running is started **without a Workstation window**, so a VM resumed from a suspended
state runs unseen and the Workstation window keeps showing the state it last had. Setup (0.1.48 and later) sets
`"startMode": "gui"`, which starts the VM the way the Workstation console does, so it appears in the Workstation
window you already have open. Set `"startMode": "nogui"` to go back. A VM that is only paused is un-paused whichever
mode is set.

## What the agent checks before it runs a command

A command is run only if it is addressed to this agent, correctly signed (HMAC-SHA256 with the agent's secret) and not
expired, checked in that order; and each command runs **at most once**: a command delivered again gets its original
result back without running again.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Agent shows offline | `Get-Process nuvrion-workstation-agent`; then the tail of `agent.log` |
| `agent.fatal ... Another Nuvrion Workstation Agent process is already running` | Harmless: a second launch exited. Only one agent runs at a time |
| A power operation did nothing | `agent.log` has an `agent.vmrun` line for every VMware command with its arguments, and `agent.vmrun.failed` with vmrun's own message |
| A VM resumed in a separate window | `startMode` is not `gui`, or the agent was not restarted after you set it. Check the agent process `StartTime` is later than `bootstrap.json`'s last write time |
| Graceful stop fails | VMware Tools is not running in the guest; use Power off |
| Agent version | Shown in the console and recorded by the platform with each heartbeat |

## Upgrading the agent from the platform

**Not available.** The platform can register an agent release and stage a deployment (`/api/v1/agent-upgrades/...`),
and an agent can ask for pending deployments, but the shipped agent does not act on them: there is no self-upgrade in
the agent. Upgrade by running the newer `Setup.exe`.

## Building the agent

The agent is bundled with `@yao-pkg/pkg` 5.12.1 for `node18-win-x64` from `apps/workstation-agent/src/agent-service.cjs`
(runtime dependency: `ws`). Bundles are currently built by hand and are **unsigned lab builds**.
