# RC1 staging qualification execution

After staging passes preflight, supply-chain verification, migrations, and readiness, copy `deploy/release-qualification-evidence.example.json` into the protected evidence workspace and bind it to the exact source commit and staging environment. Every scenario starts as `pending`; never convert a field to `passed` without retaining sanitized supporting evidence.

For a bounded initial HTTP sample, set `NUVRION_STAGING_URL` to the HTTPS staging origin and run `node tools/run-staging-http-probe.js <output.json>`. Request count defaults to 100 and concurrency to 10 and may be adjusted within the enforced limits. The runner targets the health API, rejects clear-text remote URLs and redirects, times out requests, discards response bodies, and writes only aggregate status counts, latency, throughput, origin, and time. It never writes the optional session value.

Use the initial probe only to validate routing and establish a baseline. The formal API and task load scenarios must exercise representative authenticated inventory, task, audit, and provider workflows with the approved load generator and thresholds in `docs/release-qualification.md`. Observe database connections, broker depth, event-loop and process resources, task attempts, outbox state, and provider throttling throughout.

Run provider, broker, database, and process failures one at a time in disposable staging. Record the exact fault window and recovery time. Count tasks before and after, inspect provider-native audit history for duplicate commands, and verify readiness behavior. For ambiguous accepted operations, use the approved fault harness to interrupt verification only after provider acceptance; prove the command was not reissued and reconciliation remained read-only.

Remove credentials, cookies, tokens, provider request payloads, and infrastructure addresses from retained evidence. Evaluate the completed document with `node tools/evaluate-release-qualification.js <evidence.json> [report.json]`. A nonzero result blocks RC promotion.
