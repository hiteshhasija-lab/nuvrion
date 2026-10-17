BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Custom roles (docs/roles.md): a description and a version on each role, and the new resource.tag permission (changing tags no longer rides on resource.operate) for the
-- built-in roles that had it. The platform also writes these at start-up; doing it here as well leaves no moment where an operator cannot tag.
ALTER TABLE identity.roles ADD COLUMN IF NOT EXISTS description varchar(200) NOT NULL DEFAULT '';
ALTER TABLE identity.roles ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE identity.roles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE identity.roles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roles_name_format') THEN
    ALTER TABLE identity.roles ADD CONSTRAINT roles_name_format CHECK (normalized_name ~ '^[a-z][a-z0-9_-]{1,39}$');
  END IF;
END $$;
INSERT INTO identity.permissions (permission_key, description)
VALUES ('resource.tag', 'Add, change and remove Nuvrion tags on virtual machines.')
ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO identity.role_permissions (role_id, permission_key)
SELECT role_id, 'resource.tag' FROM identity.roles WHERE normalized_name IN ('platform_admin', 'operator')
ON CONFLICT DO NOTHING;
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0034', 'role management', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
