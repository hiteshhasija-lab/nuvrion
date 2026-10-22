BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Saved views (docs/views.md): a named set of filters and a sort order for the inventory, kept per person so it follows them to any browser. No permission is added: anyone who may
-- view resources may keep views for themselves.
CREATE TABLE IF NOT EXISTS inventory.saved_views (
  view_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES identity.users(user_id) ON DELETE CASCADE,
  scope varchar(16) NOT NULL DEFAULT 'inventory' CHECK (scope IN ('inventory')),
  name varchar(60) NOT NULL,
  view jsonb NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_name_idx ON inventory.saved_views (user_id, scope, lower(name));
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0043', 'saved inventory views', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
