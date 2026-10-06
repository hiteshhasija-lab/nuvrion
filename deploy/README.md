# Deploy tooling for NOVAAPP01

These files are the canonical copies of what runs on the Nuvrion host. Nothing here is built into the
application image (the overlay tarball only contains `apps database modules providers Containerfile.overlay`),
so changing them never needs a release.

| File | Lives on the host at | Purpose |
|---|---|---|
| `upgrade-nuvrion.sh` | `~/nuvrion-upgrades/upgrade-nuvrion.sh` | Verifies a release directory, backs up, builds, migrates, swaps the container via systemd, validates health, rolls back on failure, then records the stable release. |
| `STABLE-RELEASE.json` | `~/nuvrion-upgrades/STABLE-RELEASE.json` | The record of the current stable release plus the pipeline notes. **Written by the upgrade script; do not edit the dynamic fields by hand.** |
| `Caddyfile` | the pod's Caddy container | TLS termination. |

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
