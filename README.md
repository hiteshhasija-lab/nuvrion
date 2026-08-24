# Nuvrion

Milestone 1 engineering foundation for the Nuvrion hybrid multi-cloud infrastructure management platform.

## Run locally

Requirements: Node.js 24 or newer.

```bash
npm run check
npm test
npm run migrate:check
npm run dev
```

Open `http://127.0.0.1:4100`. The server hosts the web shell and versioned API.

For the production adapter profile, install dependencies, apply all migrations, start PostgreSQL and RabbitMQ, and set `NUVRION_RUNTIME_PROFILE=production`. Task creation and outbox insertion share one PostgreSQL transaction; the relay publishes persistent messages to a durable RabbitMQ quorum queue and acknowledges them only after publisher confirmation.

## Demonstrable vertical thread

1. The browser loads the Nuvrion shell.
2. Sign in as the local `admin` user using `NUVRION_BOOTSTRAP_PASSWORD`.
3. `GET /api/v1/health` reports API, database, broker, worker, and mock-provider state.
4. An authenticated, CSRF-protected `POST /api/v1/mock/operations` creates a durable-shaped task contract with an idempotency key.
5. The mock worker executes it asynchronously.
6. `GET /api/v1/tasks/:id` returns progress and the correlation ID.

Milestone 2 includes local sessions/RBAC, encrypted write-only connection credentials, connection APIs, and the canonical identity/connection/inventory migration. Milestones 3–8 add durable tasks, normalized inventory, lifecycle operations, the enterprise console, and persistent PostgreSQL/RabbitMQ state. Milestone 9 adds VMware vCenter. Milestone 10 adds Amazon EC2. Milestone 11 adds Microsoft Azure VMs through the Azure Identity and Compute SDKs with tenant/service-principal credentials, subscription-wide paged discovery, instance-view state and health, ARM metadata normalization, start/deallocate/restart long-running operations, verified final state, and Azure-aware error mapping.

Milestone 12 adds standalone VMware ESXi and Workstation adapters. Milestone 13 adds state-aware, provider-specific lifecycle capability evaluation shared by the API validation layer and enterprise console.

Milestone 14 establishes the VMware Workstation Agent control plane with one-time enrollment, authenticated heartbeat and inventory reporting, signed expiring command envelopes, replay protection, and terminal result acknowledgement.

Milestone 15 connects agent-backed Workstation connections to unified discovery and durable lifecycle execution. Agents poll authenticated command envelopes and their acknowledged results drive normal task verification and inventory updates.

Milestone 16 adds the PostgreSQL agent registry. Enrollment tokens, encrypted signing secrets, heartbeat inventory, command queues, and terminal results now survive production API restarts.

Milestone 17 adds Workstation agent lifecycle security: heartbeat-based offline detection, one-time secret rotation, administrative revocation, queued-command rejection, and expired-command cleanup.

Milestone 18 adds scheduled maintenance and agent compatibility policy. Stale/offline and expired-command sweeps run automatically, heartbeat responses advertise upgrade readiness, and unsupported agent versions are blocked from provider operations.

Milestone 19 adds staged agent upgrade security: Ed25519-signed release manifests, artifact checksum and size verification, per-agent rollout assignments, and installed/failed/rollback state reporting. Platform-specific installer packaging remains a release-engineering step.

Milestone 20 adds the endpoint upgrade executor and Windows service packaging foundation: authenticated rollout polling, pre-mutation verification, atomic backup/replace/restart/health-check flow, automatic rollback, and guarded install/uninstall scripts using the Windows LocalService account.

Milestone 21 persists upgrade releases and deployments in PostgreSQL, records the signing-key identity in every signed manifest, and requires stable operator-provided Ed25519 keys in production so rollout trust survives API restarts.

Milestone 22 begins integrated qualification with fail-fast production configuration validation and a readiness probe covering database connectivity, required schema level, broker, worker, and agent-maintenance scheduler health.

Milestone 23 adds provider-failure resilience: bounded exponential retry before provider acceptance, durable delayed retry publication, and a verification-required terminal state after ambiguous accepted operations to prevent duplicate lifecycle commands.

Milestone 24 adds safe ambiguity recovery. Verification-required tasks can be reconciled through read-only provider discovery and are completed only when the requested final state is independently observed; lifecycle commands are never resubmitted by reconciliation.

Milestone 25 adds operator task recovery controls: queued-only cancellation and failed-only manual retry, enforced atomically in both persistence modes with audit events and durable republishing. Running and verification-required tasks remain protected from unsafe reissue.

Milestone 26 brings safe task recovery into the enterprise console with state-aware Cancel, Retry, and Reconcile actions, explicit confirmation language, and automatic task/audit refresh.

Milestone 27 adds guarded backup and recovery tooling: PostgreSQL custom-format dumps, HMAC-authenticated manifests, SHA-256 and schema compatibility verification, empty-target restore enforcement, and a recovery validation runbook.

Milestone 28 adds web security qualification: secure production cookies, CSP and browser hardening headers, JSON media-type enforcement, and bounded privacy-preserving login throttling with Retry-After responses.

Milestone 29 adds production credential key management: versioned key rings injected by a KMS/HSM-backed secret manager, active-key identifiers persisted with ciphertext, authenticated encryption context, safe rotation with retained-key decryption, and fail-fast production configuration validation.

Milestone 30 completes the Windows Workstation Agent packaging gate: signed platform- and architecture-bound `.nuvpkg` bundles, deterministic per-file manifests, traversal and unsigned-content rejection, release packaging and verification tooling, and mandatory Authenticode validation during first installation.

Milestone 31 establishes integrated release qualification: fresh commit-bound evidence, API and task performance thresholds, database/broker/provider failure recovery gates, zero lost or duplicate task requirements, and explicit proof that ambiguous accepted operations are never reissued.

Milestone 32 adds production operations hardening: cumulative request/error/latency telemetry, authenticated Prometheus export, a least-privilege production Compose profile with internal data services and controlled shutdown, immutable-image enforcement placeholders, and deployment, alerting, scaling, and recovery guidance.

Milestone 33 completes the v0.1 engineering handoff: calibrated Argon2id password hashing with transparent legacy-scrypt upgrade, a fail-closed release-candidate evidence manifest, final deployment and approval gates, and consolidated go/no-go documentation. Code completion does not authorize production promotion; external staging, recovery, signed-binary, security, product, and operations evidence remains mandatory.

RC1 staging preparation adds a non-secret deployment template, owned secret inventory, immutable-image and secret-separation preflight validation, and a controlled staging checklist. No infrastructure or credentials are created by this step.

RC1 image preparation adds a least-privilege multi-stage application image, a minimized build context, immutable Node base-image enforcement, and source-input provenance generation and verification. Registry scanning, SBOM attestation, image signing, publication, and deployment remain release-infrastructure actions.

RC1 dependency evidence adds a deterministic CycloneDX 1.6 SBOM for the locked production JavaScript graph, including package URLs, integrity hashes, source identity, and drift-detecting verification. Base-image SBOM generation and vulnerability scanning remain external build-pipeline gates.

RC1 supply-chain policy adds a fail-closed gate for immutable image identity, fresh application and base-image SBOMs, normalized vulnerability findings, time-bounded approved exceptions, image-bound signature transparency evidence, and source-bound build provenance.

RC1 staging qualification preparation adds a bounded HTTPS load probe, sanitized aggregate performance evidence, a fail-closed seven-scenario evidence template, and controlled execution guidance for load, outage, restart, and ambiguous-operation safety testing.

RC1 recovery qualification preparation adds a fail-closed isolated restore gate covering authenticated backup integrity, empty-target enforcement, schema and migration compatibility, independent secret recovery, readiness, discovery, audit continuity, task reconciliation, zero-loss and zero-duplicate requirements, and measured RPO/RTO objectives.

RC1 Workstation Agent qualification preparation adds a fail-closed architecture-specific gate for timestamped Authenticode trust, signed `.nuvpkg` identity, malware scanning, LocalService installation, enrollment and health, staged upgrade, automatic rollback, clean uninstall, secret cleanup, and production isolation.

RC1 security review preparation adds a non-disclosing repository secret scan, explicit trust-boundary and abuse-case coverage, and a fail-closed independent review gate spanning SAST, dependencies, identity/RBAC, cryptography, browser/API security, provider permissions, logging, backups, agent trust, penetration testing, remediation, and approval evidence.

RC1 environment decisions select GitHub Container Registry, VMware staging, `nuvrion.lab.sps`, and Hitesh Hasija as the initial lab owner and approver. A manual build-first GHCR workflow now generates provenance and an application SBOM and requires explicit authorization before publication.

The local profile remains dependency-light and fully runnable without infrastructure services. The production profile activates the `pg` and `amqplib` adapters defined in `package.json`.

## Layout

- `apps/web` — enterprise web shell
- `apps/api` — HTTP API and composition root
- `apps/worker` — background task worker
- `apps/workstation-agent` — secure Workstation endpoint command runtime
- `modules` — bounded platform modules
- `providers/mock` — deterministic provider adapter
- `providers/vmware-vsphere` — vCenter inventory and VM lifecycle adapter
- `providers/vmware-workstation` — Workstation Pro REST inventory and VM power adapter
- `providers/vmware-workstation-agent` — signed endpoint-agent inventory and lifecycle adapter
- `providers/vmware-esxi` — standalone ESXi Web Services inventory and VM lifecycle adapter
- `providers/aws-ec2` — EC2 inventory and lifecycle adapter
- `providers/azure-vm` — Azure VM inventory and lifecycle adapter
- `contracts` — OpenAPI and message contracts
- `database/migrations` — PostgreSQL migration baseline
- `deploy` — local service topology
- `tests` — unit and integration tests
- `docs` — architecture and developer notes
