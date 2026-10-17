BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Accounts an administrator creates, or whose password an administrator sets, start with a password only the administrator knows: this flag makes the person choose their own
-- before they can do anything else (docs/users.md).
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0037', 'must change password', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
