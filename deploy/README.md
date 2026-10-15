# Deploy tooling for NOVAAPP01

Other guides: [restoring from a backup](../docs/restore-guide.md), [connecting providers](../docs/connecting-providers.md),
[the Workstation agent](../docs/workstation-agent.md).

These files are the canonical copies of what runs on the Nuvrion host. Nothing here is built into the
application image (the overlay tarball only contains `apps database modules providers Containerfile.overlay`),
so changing them never needs a release.

| File | Lives on the host at | Purpose |
|---|---|---|
| `upgrade-nuvrion.sh` | `~/nuvrion-upgrades/upgrade-nuvrion.sh` | Verifies a release directory, backs up, builds, migrates, swaps the container via systemd, validates health, rolls back on failure, then records the stable release. |
| `STABLE-RELEASE.json` | `~/nuvrion-upgrades/STABLE-RELEASE.json` | The record of the current stable release plus the pipeline notes. **Written by the upgrade script; do not edit the dynamic fields by hand.** |
| `assemble-release.sh` | run on the workstation, not copied to the host | Turns the evidence CI produced for a commit into a release directory, after verifying it (signatures, checksums, SBOM, provenance, image scan). |
| `image-scan-exceptions.json` | read by CI and by `assemble-release.sh` | Time-limited, reasoned acceptances of fixable HIGH/CRITICAL image findings. |
| `Caddyfile` | the pod's Caddy container | TLS termination. |

## Making a release (from v0.1.173)

A release is **assembled from what CI built, scanned and signed**, not built on a workstation or on the host. The image that runs in production is the image
that was scanned: CI builds it (on arm64, the host's architecture), scans it, signs it, and the host loads it.

1. Set the release version in the `VERSION` file (`0.1.N`), commit with the change and push to `main`. CI builds the image with that version. Wait for CI to pass on that
   exact commit (`gh run list --commit <sha>`). Four jobs matter: `checks` (tests), `supply-chain` (lockfile, SBOM, build provenance, dependency audit), `image-scan`
   (builds `Containerfile.base` and the overlay, scans the image with Trivy; a HIGH or CRITICAL finding that has a fix blocks; keeps the image archive and an SBOM
   of the image) and `release-evidence` (builds the release archive with `git archive`, and GitHub signs, through Sigstore and the workflow's own identity, the build
   provenance of the release archive and the image archive, and the SBOMs of both; there is no signing key to keep).
2. Write a small change file: `{ "sourceAuthority", "summary", "details": [...], "verification", "filesChanged": [...], "requiredMigration" }`.
3. With that commit checked out: `deploy/assemble-release.sh 0.1.173 <commit> change.json`. It finds the CI run, downloads the evidence, checks the checksums, checks
   that `VERSION` says the version, that the id of the image inside the archive is the id CI recorded, runs `gh attestation verify` for every attestation (signer
   workflow, source commit, predicate type), re-verifies the SBOM and build provenance against the checkout, re-evaluates the scan policy, and writes
   `Nuvrion-v0.1.173/`: the release archive, the **image archive** (`Nuvrion-Image-<version>.tar`, about 250 MB), `release-manifest.json` (with `server.imageArchive`
   and a `supplyChain` section), `SHA256SUMS.txt` covering every file, both SBOMs, the provenance, the signed bundles and the scan report.
4. `scp -r` it to `~/nuvrion-upgrades/releases/`, then `upgrade-nuvrion.sh <dir> --check`, read it, then `--yes`. The script verifies the checksums and that the
   evidence is complete and belongs to the archive, checks that the scan passed, **loads the image archive** (it fails unless the loaded image has the id the manifest
   names and reports this release's version), runs the migration, swaps the container and validates health. No image is built on the host and no base image is
   needed there. (The host has no signature verifier; signatures are verified where the release is assembled. Verify again anywhere with
   `gh attestation verify <archive> --bundle <bundle> --repo hiteshhasija-lab/nuvrion`.)

Older releases (without `server.imageArchive`) are built on the host from the overlay archive and `localhost/nuvrion:base-arm64`; the script still does that for
them.
Image archives are large; the upgrade script deletes the ones in release directories older than 14 days. A release can be assembled again from the CI evidence for
30 days (the image archive artifact is kept 30 days; the rest 90).

### The base image

`Containerfile.base` has two stages: the full Node image (compilers, used only to install dependencies) and the slim image of the same Node version, which is what
ships; npm and corepack are removed from it, and one package that has a Debian security fix the pinned image lacks (`perl-base`) is upgraded. Bump the pinned digests
deliberately, keeping the Node version in step; when the pinned image already has the fix, delete the `apt-get` line (the image-scan job names acceptances that are
no longer needed). Nothing is built on the host any more, and no base image is kept there. A release without an image archive (the old way) needs `localhost/nuvrion:base-arm64`,
which the script refuses to proceed without; build it from a checkout of the release commit at a quiet moment (`podman build -f Containerfile.base -t localhost/nuvrion:base-arm64 .`,
which loads the host for about a minute) or, better, release through CI so that the image is built and scanned there.

### Image findings

`image-scan-exceptions.json` accepts a finding for at most 45 days, with a written reason; an expired entry blocks again. Prefer taking the fix.
Findings with no fix are reported in `image-scan-summary.json` and do not block.

## After every release

The script rewrites `STABLE-RELEASE.json` on the host. Copy it back into git so the history is kept:

```bash
scp -i ~/.ssh/nuvrion_lab hiteshhasija@10.0.0.101:nuvrion-upgrades/STABLE-RELEASE.json deploy/STABLE-RELEASE.json
git add deploy/STABLE-RELEASE.json && git commit -m "Record v<version> as stable" && git push
```

`git log -p deploy/STABLE-RELEASE.json` is then the release history (version, time, image, source commit, reason, rollback image).

## Rebuilding the host

1. Clone the repo to `~/nuvrion` (it is public, no credentials needed).
2. `install -m 755 ~/nuvrion/deploy/upgrade-nuvrion.sh ~/nuvrion-upgrades/upgrade-nuvrion.sh`
3. Nothing else is needed for the record: if `~/nuvrion-upgrades/STABLE-RELEASE.json` is missing, the script
   seeds it from `~/nuvrion/deploy/STABLE-RELEASE.json` (so the pipeline notes carry over) on the next deploy.
4. `jq` must be installed on the host (the script checks for it).

## What the script records

`stableVersion`, `markedStableAt`, `markedBy`, `image`, `releaseDirectory`, `sourceBaselineCommit` and `reason`
(from the release manifest's `change.summary`), and `rollbackImage`. Everything else in the file is preserved.
Writing the record is best effort: a failure prints a warning but never fails an upgrade that already passed validation.

## Cleanup after each deploy

After a validated deploy the script also tidies up (best effort, same rule: it never fails a good upgrade):

- removes this deploy's build directory, and any other build directory older than 7 days (a failed deploy keeps its
  directory for a week for diagnosis);
- untags `localhost/nuvrion:X.Y.Z` version tags beyond the newest 5 (never the version just deployed, `:stable`, the
  `rollback-*` images, or anything a running container uses), then runs `podman image prune -f`, which removes the
  build layers those old tags were keeping alive;
- prints the free disk space afterwards.

Measured on NOVAAPP01 (17 GB root disk): the one-time cleanup freed about 0.5 GB. Most of the rest of the container storage
(about 4.4 GB) belongs to the NovaDesk and NovaConnect images and their build layers, which this script does not touch.

## Task recovery

Every 30 seconds (and once at start) the API looks for tasks that would otherwise be stranded:

| Situation | What happens |
|---|---|
| A task is `running` but its lease expired (the worker renews its lease every 10 s while it works, so this means the process died) and the provider had **not** accepted the operation | It is queued again and announced again. |
| The same, but the provider **had** accepted the operation | It becomes `verification_required`, so the operation is not executed a second time; the next discovery of that connection compares the provider's real state with the expected one. |
| A task is `queued`, due, has waited more than 2 minutes, and has no message waiting or published in that time (a message lost with the broker) | It is announced again. A duplicate message is harmless: a task that is no longer queued is not claimed. |

The log line is `tasks.recovered` with the counts. Environment variables (API env file): `NUVRION_TASK_RECOVERY_INTERVAL_MS` (default 30000) and
`NUVRION_TASK_REANNOUNCE_AFTER_MS` (default 120000). The outbox relay reports a broker outage once (then at most once a minute) and logs
`outbox.publish_recovered` when it works again.

## The database roles

The API does not connect as the database owner. Migration 0031 defines a group role, `nuvrion_app`, that holds what the application code does and nothing
more; the API connects as a login role that is a member of it (`nuvrion_api` on the lab host). Migrations, backups and the upgrade script keep using the owner.

| What | The API's login role | The owner |
|---|---|---|
| Read and write rows of the operational tables | yes | yes |
| Change or delete an audit event | **no** (select and insert only) | yes |
| Write `platform.schema_migrations` | **no** (select only) | yes |
| Create, alter or drop anything; truncate | **no** | yes |
| Read server files, run commands (`COPY ... PROGRAM`), create roles | **no** | yes (superuser) |

Every PostgreSQL test runs as that role, so a query that needs a right the application does not have fails in CI, and `database/test/application-role.test.js`
pins the table-by-table rule. A table a later migration creates is usable by the application without another grant (default privileges); a new **schema**
needs a line in migration 0031's successor and in that test.

To switch a platform over (once, after a release containing migration 0031 has been applied), run on the host:

```bash
deploy/application-role.sh
```

It creates the login role with a generated password (never printed), proves through the one PostgreSQL rule that checks passwords that it logs in, is not a
superuser, reads the tables and cannot create objects, rewrites only `NUVRION_DATABASE_URL` in the env file, restarts the API, waits for health and readiness,
confirms the API's own database session runs as that role, and puts everything back if any step fails. To go back to the owner, set the owner's password
(`ALTER ROLE nuvrion PASSWORD ...` as the owner) and write the owner's URL into the env file; nothing else depends on the choice.

## Data retention

The API prunes two history tables on a schedule (every 6 hours, first run a minute after start), in batches, always
keeping each connection's newest 100 rows so a long-dead connection still shows how it last failed:

| Table | Default | Environment variable (set in the API env file; `0` turns it off) |
|---|---|---|
| `inventory.discovery_runs` | 30 days | `NUVRION_RETENTION_DISCOVERY_DAYS` |
| `connections.health_events` | 90 days | `NUVRION_RETENTION_HEALTH_EVENTS_DAYS` |

Metric samples prune themselves after 7 days (`NUVRION_METRIC_RETENTION_MS`; the UI never shows more than 7 days).
Audit events and tasks are never pruned. Each prune is logged as `retention.pruned` with the table and row count.

## Dependencies and supply chain

`package-lock.json` pins every runtime dependency (101 packages) to an exact version, registry source and SHA-512 hash. It
was taken from the running base image, so the lockfile describes what production actually runs. `Containerfile.base` installs
with `npm ci --omit=dev` and pins its Node base image by digest. To add or update a dependency, change `package.json` with
`npm install <package>` (this updates the lockfile), commit both, and rebuild the base image as described above. Do not edit the
lockfile by hand.

Every push to `main`, every pull request and a weekly schedule run a `supply-chain` job in CI that:

- installs from the lockfile and runs the policy tests (pins for the base image, GitHub Actions and service images);
- creates a CycloneDX SBOM from the lockfile and verifies it against the lockfile again;
- creates a build-provenance manifest (commit, base image digest, hash of every file the images are built from) and verifies it;
- fails on any known high or critical vulnerability in a runtime dependency (`npm audit --omit=dev --audit-level=high`);
- keeps the SBOM and provenance files as a workflow artifact for 90 days (`supply-chain-evidence-<commit>`).

Not covered yet: container-image vulnerability scanning, image signing and a verified signature on the SBOM or provenance
(`tools/evaluate-supply-chain.js` already defines that evidence for a release candidate), and attaching the SBOM to each release directory.
