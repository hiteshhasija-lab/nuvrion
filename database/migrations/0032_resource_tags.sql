BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Nuvrion's own tags on resources (docs/tagging.md). A tag is a lower-case key with an optional value; provider tags (Azure, AWS) stay in the resource's
-- attributes and are shown beside these, never mixed into this table. The limits (key 64, value 128, 50 per resource) are enforced by the application; the
-- constraints here keep a bad row from ever being stored whatever writes it.
CREATE TABLE IF NOT EXISTS inventory.resource_tags (
  resource_id uuid NOT NULL REFERENCES inventory.resources(resource_id) ON DELETE CASCADE,
  tag_key varchar(64) NOT NULL CHECK (tag_key ~ '^[a-z0-9][a-z0-9._:/-]*$'),
  tag_value varchar(128) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, tag_key)
);
CREATE INDEX IF NOT EXISTS resource_tags_key_value_idx ON inventory.resource_tags (tag_key, tag_value);
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0032', 'resource tags', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
