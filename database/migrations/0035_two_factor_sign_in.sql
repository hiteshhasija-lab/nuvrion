BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Two-factor sign-in (docs/mfa.md). The authenticator secret is kept encrypted (AES-256-GCM, bound to the user), the backup codes only as hashes, and the last accepted
-- time step so a code works once. A session says when it was verified and how many wrong codes it has seen. The policy is a single row naming the roles that need an
-- authenticator; roles themselves are not changed, so the built-in ones can be named.
CREATE TABLE IF NOT EXISTS identity.user_mfa (
  user_id uuid PRIMARY KEY REFERENCES identity.users(user_id),
  enabled boolean NOT NULL DEFAULT false,
  secret_cipher jsonb,
  pending_cipher jsonb,
  last_step bigint NOT NULL DEFAULT 0,
  backup_hashes text[] NOT NULL DEFAULT '{}',
  enrolled_at timestamptz,
  failed_count integer NOT NULL DEFAULT 0,
  failed_since timestamptz,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_mfa_enabled_has_secret CHECK (NOT enabled OR secret_cipher IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS identity.mfa_policy (
  policy_id smallint PRIMARY KEY DEFAULT 1 CONSTRAINT mfa_policy_single_row CHECK (policy_id = 1),
  required_roles text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO identity.mfa_policy (policy_id) VALUES (1) ON CONFLICT (policy_id) DO NOTHING;
ALTER TABLE identity.sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
ALTER TABLE identity.sessions ADD COLUMN IF NOT EXISTS mfa_failures smallint NOT NULL DEFAULT 0;
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0035', 'two-factor sign-in', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
