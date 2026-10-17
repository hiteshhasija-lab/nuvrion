# Backups and release evidence

Two things leave the production host automatically and are kept on the owner's computer: **scheduled backups** and the **evidence of every release**. This page
says what they are, how they are protected, how to check and use them, and what they do **not** protect against.

## The picture

```
 NOVAAPP01 (production)                                      owner's computer
 ─────────────────────────────────────────────                ───────────────────────────────────────────────
 every hour  backup-nuvrion.sh                                every hour  node tools/backup.js pull   (launchd)
   pg_dump → restore into a scratch database (proof)            ssh/rsync, pull-only: the host cannot reach this machine
   tar of the configuration                                     check signature + every checksum + restore check
   encrypt both to the recovery CERTIFICATE ───────────────►    file the good sets, quarantine the bad ones
   manifest.json + Ed25519 signature (host-only key)            Backup/NOVAAPP01/sets/<time>/   (read-only)
 ~/nuvrion-backups/<time>/   (newest 48 sets)                   keeps 48 hourly, 30 daily, 26 weekly sets
                                                                Backup/evidence/v<version>/  + LEDGER.jsonl  (every release, hash-chained, immutable)
 ~/nuvrion-upgrades/releases/  (evidence of each release) ───►
```

The recovery **private** key exists only on the owner's side (`~/.config/nuvrion-backup/recovery-key.pem`), so nothing that leaves the host can be read without it. The
signing key exists only on the host, so the owner's side can tell a set the host made from anything else.

## What a backup set holds

`~/nuvrion-backups/<UTC time>/` on the host, and the same (minus the plain dump) on the owner's computer:

| File | What it is |
|---|---|
| `nuvrion.dump.cms` | `pg_dump -Fc` of the database, encrypted to the recovery certificate (CMS, AES-256) |
| `nuvrion-config.tar.cms` | the env file **with the encryption keys**, the **agent signing key pair**, the CA certificate, the TLS certificate and key, the Caddyfile and the API run script, encrypted the same way. The older pre-upgrade backups held only the env file and the CA, so the agent signing key was in no backup at all |
| `manifest.json` | format, time, host, application version, the SHA-256 and size of each file (encrypted and plain), the hash of the recovery certificate, and the **result of restoring this dump into a scratch database on the host** (migrations, tables, row counts of the main tables) |
| `manifest.sig` | an Ed25519 signature over the exact bytes of `manifest.json` |
| `COMPLETE` | written last; a set without it was interrupted and is never used |
| `nuvrion.dump` | (host only, newest 6 sets) the plain dump, for a fast local restore |

The existing pre-upgrade backups (`~/nuvrion-upgrades/backups/`, one per deploy, last five kept) are unchanged; they are a different thing (a rollback point taken just
before a release) and stay on the host.

## Where the keys live

| Key | Lives | Why |
|---|---|---|
| Recovery **private** key | owner's computer, `~/.config/nuvrion-backup/recovery-key.pem` (mode 600) **and a copy you make that is not on that computer** | the only way to read a backup or recover the platform's encryption keys |
| Recovery certificate (public) | the host (`~/.config/nuvrion/backup-recovery-cert.pem`) and the owner's computer | lets the host encrypt without being able to decrypt |
| Signing **private** key | the host only (`~/.config/nuvrion/backup-signing-private.pem`, mode 600) | proves a set came from the host |
| Signing public key | the owner's computer (`~/.config/nuvrion-backup/host-signing-public.pem`) | verifies sets |

**Make the second copy of the recovery private key now** (a password manager's secure note, or a printed copy in a safe). If the owner's computer is lost, the copies of
the backups are readable by nobody, and the platform's encryption keys are lost with them.

The backup folder (`Desktop/Nuvrion/Backup`) is inside the Desktop, which is synced by iCloud Drive on the owner's Mac. That is acceptable only because everything in a
set is encrypted; the recovery key is deliberately kept outside the Desktop (and outside `~/Documents`).

## Setting up (done once; done on 17 October 2026)

On the owner's computer:

```bash
node tools/backup.js init --host 10.0.0.100 --user hiteshhasija --identity ~/.ssh/nuvrion_lab --destination ~/Desktop/Nuvrion/Backup
```

On the host (copy `deploy/backup-nuvrion.sh` to `~/nuvrion-upgrades/`, the certificate to `/tmp`):

```bash
~/nuvrion-upgrades/backup-nuvrion.sh --init /tmp/recovery-cert.pem     # prints the signing public key
```

Back on the owner's computer, save the printed key to a file and `node tools/backup.js host-key <file>`. Then install the schedules:

```bash
# host: copy deploy/nuvrion-backup.service and deploy/nuvrion-backup.timer to ~/.config/systemd/user/, then
systemctl --user daemon-reload && systemctl --user enable --now nuvrion-backup.timer
# owner's computer:
node tools/backup.js schedule install        # a launchd agent: pulls every hour and at login
```

Do **not** run `systemd-analyze --user verify` on the host to check the unit files: it replaces the user manager's private socket and leaves `systemctl --user` refused for
every later login (the services keep running, but the next upgrade's restart step would fail). Starting the service once is the check.

## Looking after it

| Command (owner's computer) | What it does |
|---|---|
| `node tools/backup.js verify` | re-checks **every** held set (signature, files, restore check) and the whole evidence archive; exits non-zero if anything is wrong or the newest set is more than 3 hours old |
| `node tools/backup.js status` | what the last pull did |
| `node tools/backup.js pull` | what the schedule runs; safe to run by hand |
| `node tools/backup.js decrypt latest OUTDIR` | decrypts a set with the recovery key after checking it, and unpacks the configuration |
| `backup-nuvrion.sh --status` (host) | the last successful run and, if the last run failed, why |

Run `verify` after a long absence, and before relying on a backup. The log of the hourly pull is `~/Library/Logs/nuvrion-backup.log`. A failed run on the host leaves no
partial set, writes `~/nuvrion-backups/last-failure.json`, and makes the systemd unit fail (`systemctl --user status nuvrion-backup.service`).

## Restoring

`node tools/backup.js decrypt <set|latest> <empty folder>` writes `nuvrion.dump`, `nuvrion-config.tar` and the unpacked `config/` (the files in the clear: delete them
afterwards). Then follow [restore-guide.md](restore-guide.md) from step 2; the env file and keys are in `config/`. What the machinery has proven so far:

- on the host, every backup is restored into a scratch database and checked (migrations, tables, row counts) before it counts;
- on the owner's computer, the decrypted bytes equal the bytes the host restored (their SHA-256 is in the signed manifest), and the decrypted configuration equals the live files;
- a restore into a **separate** PostgreSQL with the application started on it was done once, by hand, on 12 October (restore-guide.md); it has not been repeated with a set from this
  pipeline. Do that rehearsal before calling the recovery gate met.

## Retention

| Where | What is kept |
|---|---|
| Host, plain dump | the newest 6 sets |
| Host, sets | the newest 48 (two days of hourly sets) |
| Owner's computer, backup sets | the newest 48 hourly, then one per day for 30 days, then one per week for 26 weeks (about 100 sets, about 3 GB at today's 31 MB per set) |
| Owner's computer, release evidence | **forever**: it is a record, about 3 MB per release |

Only sets that passed every check count toward the policy, so a damaged set never pushes a good one out. Change the numbers in `~/.config/nuvrion-backup/config.json`
(`retention`: `hourly`, `daily`, `weekly`).

## The release-evidence archive

CI keeps a release's evidence for 90 days (the image archive 30), and the host's release directories can be edited by anyone with the account. After every pull the
owner's computer also copies **every release directory on the host except the image archive and the agent executable** (the manifest, the checksum list, the SBOMs, the
signed attestation bundles, the scan reports, the release notes, the release archive) to `Backup/evidence/v<version>/` and appends a line to `Backup/evidence/LEDGER.jsonl`.

- A release whose files do not match its own `SHA256SUMS.txt` is **refused** and reported, not archived.
- Each ledger line holds the hash of the line before it. Editing a line, removing one from the middle, reordering or repeating a version breaks the chain, and `verify` says so.
- On macOS the release folders get the user-immutable flag and the ledger the append-only flag, so they cannot be changed or deleted by accident (to remove one on purpose:
  `chflags -R nouchg <folder>`). Set `"immutable": false` in the config to switch this off (for example if iCloud complains about the flags).
- Removing the **newest** lines is not visible from the chain alone. Write down the head hash (`verify` prints it; it is also in `Backup/evidence/status.json`), for example in the
  status document, and compare later. The head at the first archive (17 October 2026, 65 releases, v0.1.121 to v0.1.186) is
  `db5006642803ad5019b57ba007f95db0f040f96972d19af1658ad814bcc0ac00`.
- The signatures in the attestation bundles can still be verified against GitHub's public transparency log with `gh attestation verify`, whatever happens to the repository's own artifacts.

## What this does and does not protect against

Protects against: loss or corruption of the host's disk (a recent, restorable copy exists elsewhere); a backup that does not restore (it is tried every time); a damaged or
altered copy (signature and checksums); the loss of the encryption keys and the agent signing key together with the host; loss of release proof after CI's 90 days; an edited or
shortened evidence archive (with the head hash written down).

Does **not** protect against:

- **Losing both the recovery key and the owner's computer.** The copies are unreadable without the key. This is the single point of failure, and the second copy of the key is yours to make.
- **A recovery point better than about an hour.** Backups are hourly and are pulled when the owner's computer is on and online; the platform can lose up to an hour of data (more if
  the computer was off). The recovery gate in `docs/restore-guide.md` still asks for 900 s, so the gate stays blocked on RPO. Meeting it needs continuous WAL archiving, which is
  a larger piece of work and is not done.
- **A host that is compromised.** The signing key is on the host, so an attacker there can make sets that verify. The pipeline detects damage and tampering after the fact (in transit,
  or on the owner's computer), not a malicious host. The attacker still cannot read earlier sets: they cannot decrypt without the recovery key.
- **A disaster that takes the host and the owner's computer together** (for example one building). An additional copy elsewhere (a USB disk, cloud storage with the encrypted sets) would
  cover that; the sets are safe to store anywhere because they are encrypted.
- **The owner's computer being off.** Nothing is pulled while it is; the host keeps 48 hours of sets, so a weekend away loses nothing, a week away loses the oldest.

## Files

`deploy/backup-nuvrion.sh`, `deploy/nuvrion-backup.service`, `deploy/nuvrion-backup.timer` (host); `tools/backup.js` and `modules/platform/src/backup-*.js`,
`evidence-*.js` (owner's computer); tests in `deploy/test/backup-*.test.js` and `modules/platform/test/backup-*.test.js`, `evidence-*.test.js`.
