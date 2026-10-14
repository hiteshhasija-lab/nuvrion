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

From agent 0.1.49 the platform can upgrade an agent. The first move to 0.1.49 is still a run of `Setup.exe`: earlier agents
cannot act on a staged upgrade.

**How it stays safe.** The agent installs an upgrade only if every one of these holds, and stops at the first that does not:

1. The release manifest is signed by the key **pinned in this agent's `bootstrap.json`** (`upgradeTrustedPublicKey`).
   The key the platform sends along with a deployment is ignored, and an agent with no pinned key refuses every upgrade.
2. The version is **newer** than the running one. The agent never downgrades.
3. The download is exactly the size in the manifest (checked while it streams) and its SHA-256 matches.
4. The downloaded executable runs `--self-check` and reports the version the manifest names.

Only then is it swapped in. The previous executable is kept as `nuvrion-workstation-agent.exe.old` and a watchdog, run from
that previous executable, starts the new agent and waits up to 3 minutes for it to prove it is healthy (its first
successful heartbeat). If it does not, the watchdog stops it, restores the previous executable and starts that, and the
restored agent reports `rolled_back`. The agent reports `downloading`, `ready` and `installed` (or `failed` /
`rolled_back`) to the platform at each step, and a result that cannot be sent is kept and retried.

**To upgrade an agent from the console** (platform administrators): open **Connections**, then the **Workstation agents** panel.

1. **Pin the signing key once per agent.** Open *Signing key to pin on an agent*, add the key to the agent's `bootstrap.json` as
   `upgradeTrustedPublicKey` and restart the agent (see below for the file edit). An agent refuses every upgrade until this is done.
2. **Add the build:** *Add agent build…*, choose `nuvrion-workstation-agent.exe`, enter the version it reports and the address the
   agent uses for the platform (its `apiUrl`; the page fills in the address you are browsing, which is right when you reach the
   console by the same name). The console checks the file, keeps it on the platform and registers a signed release.
3. **Upgrade:** *Upgrade…* on the agent's row, choose the build and confirm. Only builds newer than the agent's version are offered.
4. **Follow it:** the row shows *Waiting for the agent*, *Downloading*, *Installing*, then *Upgraded*. A refusal or a rollback is
   shown with the reason in words. *Cancel upgrade* frees an agent whose upgrade has not started.

Each upload, stage and cancel is in the audit history (`agent.upgrade_build_added`, `agent.upgrade_staged`,
`agent.upgrade_cancelled`) with who did it. An agent has one upgrade at a time: staging a second is refused until the first has
finished or been cancelled.

**To upgrade an agent from the command line:**

1. **Pin the signing key once per agent.** As an administrator get the key (`GET /api/v1/agent-upgrades/signing-key`, or
   the tool below prints it) and add it to `bootstrap.json`, then restart the agent:
   ```json
   "upgradeTrustedPublicKey": "-----BEGIN PUBLIC KEY-----\nMCow...\n-----END PUBLIC KEY-----\n"
   ```
   From agent 0.1.50 the key may also be given as the bare base64 line; earlier agents need the BEGIN and END lines. A
   result the platform keeps refusing is given up on after about an hour of polls (`agent.upgrade.report_abandoned`).
2. **Put the new executable on the platform host**, named by its SHA-256, in the `agent-artifacts` directory next to the
   platform's upgrades directory (on the lab host: `~/.local/share/nuvrion-upgrades/agent-artifacts/<sha256>`). The API
   only reads this directory.
3. **Register and stage it:**
   ```bash
   NUVRION_USERNAME=<admin> NUVRION_PASSWORD=<password> node tools/stage-agent-upgrade.js \
     --url https://<platform> --agent <agent id> --exe ./nuvrion-workstation-agent.exe --version 0.1.50-lab.1
   ```
   The version must equal what the executable reports (`nuvrion-workstation-agent.exe --self-check`) and be higher in
   major.minor.patch than the installed one. **`--url` must be exactly the address the agent itself uses** (`apiUrl` in its
   `bootstrap.json`): the artifact address is part of the signed manifest, and the agent sends its credential and trusts
   its CA only for its own platform origin, so another name for the same host fails with a TLS error
   (`NUV_AGENT_UPGRADE_DOWNLOAD_FAILED ... unable to verify the first certificate`).
4. **Watch it:** the agent polls once a minute (`upgradePollIntervalMs` in `bootstrap.json`). `agent.log` has the
   `agent.upgrade.*` events and the console shows the new version after the restart. Run `verify-install.ps1` to confirm.

| `agent.log` event | Meaning |
|---|---|
| `agent.upgrade.failed` | Refused or failed before anything was replaced; the code says why (`NUV_AGENT_UPGRADE_KEY_NOT_PINNED`, `..._SIGNATURE_INVALID`, `..._NOT_NEWER`, `..._CHECKSUM_MISMATCH`, `..._SELF_CHECK_FAILED`) |
| `agent.upgrade.swapped` | Verified and swapped in; the agent is about to restart |
| `agent.upgrade.healthy` | The new agent's first heartbeat succeeded |
| `agent.upgrade.rolled_back` | The new agent did not come up healthy; the previous one is running again |

Left behind after a rollback: `nuvrion-workstation-agent.exe.failed` (the executable that did not come up, for diagnosis).

**What is not covered yet:** the executable is built by hand and unsigned (the console takes the file; it does not build it), and
the rollback path has been exercised in tests and on macOS but not yet on a Windows host. A fresh install still needs `Setup.exe`
on the host: the platform cannot reach into a host that has no agent.

## Building the agent

The agent is bundled with `@yao-pkg/pkg` 5.12.1 for `node18-win-x64` from `apps/workstation-agent/src/agent-service.cjs`
(runtime dependency: `ws`). Bundles are currently built by hand and are **unsigned lab builds**.
