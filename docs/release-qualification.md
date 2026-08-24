# Integrated release qualification

Nuvrion v0.1 release candidates must be exercised in an isolated production-like environment using PostgreSQL, RabbitMQ, TLS, production configuration validation, and non-production accounts for every enabled provider. Record results in `nuvrion-release-qualification/v1` JSON and evaluate them with `node tools/evaluate-release-qualification.js <evidence.json> [report.json]`. A nonzero exit code blocks promotion.

Required scenarios are API load, durable task load, provider outage, broker outage, database outage, process restart, and an accepted operation with ambiguous verification. Default gates require API p95 latency at or below 500 ms with at least 50 requests/second and at most 1% errors; task p95 completion at or below 5 seconds with at least 10 tasks/second; zero lost tasks; and zero duplicate provider operations. Evidence must identify the tested commit and environment and be no older than seven days.

During fault tests, verify that readiness becomes unavailable when the database is inaccessible, the outbox retains work while RabbitMQ is unavailable, provider errors expose no credentials, restart recovery preserves tasks, and ambiguous accepted operations enter `verification_required` without command reissue. Reconciliation must use discovery only. Capture sanitized load-generator output, service logs, broker/database observations, and final task/audit records with the evidence artifact.

Never run destructive fault injection against production. Use disposable staging infrastructure and provider resources explicitly reserved for qualification. Promotion additionally requires the normal syntax, migration, unit, integration, backup/restore, packaging, and security checks.
