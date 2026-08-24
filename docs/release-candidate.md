# Nuvrion v0.1 release-candidate handoff

The v0.1 implementation milestones are code-complete, but that does not by itself authorize production deployment. Promotion is fail-closed and requires a `nuvrion-release-candidate/v1` manifest evaluated with `node tools/evaluate-release-candidate.js <candidate.json> [report.json]`.

The manifest must bind an immutable commit and v0.1 release-candidate version to fresh referenced evidence for all eight gates: automated verification, production-like staging qualification, an isolated backup/restore drill, a real signed Workstation Agent package, security review, documentation review, product approval, and operations approval. Evidence older than seven days is rejected by default. Do not mark a gate passed using simulated results or this repository's unit-test fixtures.

Engineering handoff includes the API and web hosts, durable task/outbox workflow, provider adapters, Workstation Agent control and upgrade planes, database migrations, production configuration checks, backup/restore tooling, signed package tooling, release qualification evaluator, hardened deployment profile, and operational telemetry. Governing product, architecture, database/API, UI/UX, and implementation-plan drafts are available in `outputs/`.

Before the first candidate, pin immutable container images, provision secrets through the approved manager, generate stable Ed25519 release keys in the signing service, produce and Authenticode-sign the Windows executable, verify and publish its `.nuvpkg`, apply migrations to disposable staging, and execute every scenario in the release-qualification runbook. Restore a fresh backup to an empty recovery database and retain the verified report. Complete threat-model/security review and provider permission review using non-production accounts.

At go/no-go, confirm readiness, dashboards and alerts, rollback ownership, recovery contacts, maintenance window, data retention, operator access, provider change authorization, and trademark status. Preserve the approved manifest and referenced evidence with release artifacts. If any evidence is missing, stale, contradictory, or tied to a different commit, the candidate remains blocked.

Current repository status: automated source tests, syntax checks, and migration validation can be executed locally. Production promotion remains blocked until the external staging, recovery, signed-binary, review, and approval evidence described above is supplied.
