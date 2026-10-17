BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- The datacenters, clusters, hosts, datastores and networks a provider reports besides virtual machines (docs/infrastructure.md). They live apart from inventory.resources so that
-- nothing that lists or counts virtual machines can ever see them. A virtual machine's placement (its host, datastores and networks) is kept in its provider metadata.
CREATE TABLE IF NOT EXISTS inventory.infrastructure_objects (
  object_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections.provider_connections(connection_id),
  kind varchar(16) NOT NULL CHECK (kind IN ('datacenter', 'cluster', 'host', 'datastore', 'network')),
  native_id varchar(256) NOT NULL,
  name varchar(256) NOT NULL,
  parent_native_id varchar(256),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  lifecycle_state varchar(16) NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'missing', 'deleted')),
  observed_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  missing_since timestamptz,
  UNIQUE (connection_id, kind, native_id)
);
CREATE INDEX IF NOT EXISTS infrastructure_objects_connection_idx ON inventory.infrastructure_objects (connection_id, kind);
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0033', 'infrastructure objects', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
