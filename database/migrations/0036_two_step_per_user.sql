BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Two-step verification is required per person, chosen by an administrator, instead of per role (docs/mfa.md). The role policy of migration 0035 is carried over once: everyone who
-- holds a role it named becomes "required", and the policy is emptied in the same statement so that running this again at the next deploy does not bring it back after an
-- administrator has changed a person's setting. The mfa_policy table itself is left in place, unused (an earlier release still reads it; it is empty and harmless).
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;
UPDATE identity.users u SET mfa_required = true, row_version = u.row_version + 1, updated_at = now()
WHERE EXISTS (
  SELECT 1 FROM identity.user_roles ur JOIN identity.roles r ON r.role_id = ur.role_id
  WHERE ur.user_id = u.user_id AND r.normalized_name = ANY (SELECT unnest(required_roles) FROM identity.mfa_policy WHERE policy_id = 1)
) AND NOT u.mfa_required;
UPDATE identity.mfa_policy SET required_roles = '{}', updated_at = now() WHERE policy_id = 1 AND cardinality(required_roles) > 0;
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0036', 'two-step verification per user', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
