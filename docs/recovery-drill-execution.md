# RC1 isolated recovery drill

Run this drill only in the approved disposable recovery environment. Never point restore tooling at production or at a database containing schemas. Start with the authenticated staging backup and its manifest, provision a new empty target with a distinct identity, and copy `deploy/recovery-drill-evidence.example.json` into the protected evidence workspace.

Record the recovery start time before verifying the manifest. Use `deploy/restore-postgres.sh <dump> <manifest>` with `NUVRION_RESTORE_DATABASE_URL` set to the empty target. The script verifies HMAC, SHA-256, size, schema compatibility, and target emptiness before invoking restore. Restore keys and application secrets separately through the approved recovery path; they must not be embedded in backup media.

After restore, apply outstanding migrations, start the platform, and require readiness to pass. Compare task, audit, connection, resource, agent, release, and deployment counts with the pre-backup inventory. Run provider discovery using non-production accounts. Reconcile all `verification_required` tasks through read-only discovery and confirm that no lifecycle command is resubmitted. Measure RPO from the newest expected durable record absent from the backup and RTO from drill start until the recovered platform is operationally ready.

The default release gate requires RTO at or below 3,600 seconds, RPO at or below 900 seconds, zero lost tasks, and zero duplicate provider operations. Retain sanitized command results, timestamps, count comparisons, readiness output, discovery summaries, task/audit reconciliation, and cleanup confirmation. Do not retain database credentials, provider credentials, keys, tokens, or raw sensitive records.

Complete the evidence document and run `node tools/evaluate-recovery-drill.js <evidence.json> [report.json]`. The gate rejects stale evidence, a reused target, incomplete cryptographic checks, missing independent-secret recovery, failed readiness or discovery, unreconciled tasks, exceeded objectives, or missing retained evidence.
