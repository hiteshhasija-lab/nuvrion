# RC1 staging preflight and secret inventory

This package prepares an isolated Nuvrion v0.1 RC1 staging deployment. It does not authorize production deployment and contains no usable credentials. Populate `deploy/staging.env.example` through the approved secret manager, render it to a temporary owner-readable environment file, run `node tools/validate-staging-environment.js <rendered-file>`, and securely destroy the rendered file after deployment.

## Secret inventory

| Item | Owner | Required control | Rotation event |
|---|---|---|---|
| PostgreSQL password and database URL | Database operations | Unique staging credential; TLS-capable connection; never logged | Suspected disclosure, staff/access change, scheduled rotation |
| RabbitMQ password and broker URL | Messaging operations | Unique staging credential; AMQPS; least-privilege virtual host | Suspected disclosure, staff/access change, scheduled rotation |
| Bootstrap administrator password | Identity owner | Unique high-entropy one-time value; change after first controlled login | Immediately after bootstrap or suspected disclosure |
| Agent-secret master key | Security/KMS owner | Minimum 32 characters; KMS-backed injection; separate from all other keys | Cryptoperiod or suspected disclosure |
| Provider credential key ring | Security/KMS owner | Versioned keys; active key ID; retain retired keys through re-encryption | Planned rotation or suspected disclosure |
| Backup integrity key | Recovery owner | Stored separately from backup media and encryption keys | Cryptoperiod or suspected disclosure |
| Ed25519 release private key | Release security | Non-exportable signing service/HSM preferred; never placed on application hosts | Signing-key rollover or suspected disclosure |
| Ed25519 release public key | Release engineering | Independently distributed and fingerprint-verified | Private-key rollover |
| Provider accounts | Infrastructure owners | Non-production resources; least privilege; provider-native audit enabled | Review failure, scope change, suspected disclosure |

## Pre-deployment checklist

1. Reserve a staging DNS name and configure TLS at the reverse proxy.
2. Create isolated PostgreSQL and RabbitMQ storage and recovery targets.
3. Approve immutable image digests for Nuvrion, PostgreSQL, and RabbitMQ.
4. Create every secret above with distinct values and recorded ownership.
5. Render the staging environment, run preflight, and retain only the sanitized result.
6. Deploy with `deploy/compose.production.yaml`; do not expose database or broker ports.
7. Apply all 16 migrations and require readiness to report `ready`.
8. Change the bootstrap password after controlled first login.
9. Configure authenticated metrics collection, dashboards, alerts, and log retention.
10. Snapshot the deployed commit and image digests before beginning RC qualification.

The preflight validator checks production runtime requirements, Ed25519 key pairing, immutable image digests, required secret presence, placeholder rejection, proxy mode, and basic key/password separation. It deliberately reports names and problems only—not secret values.
