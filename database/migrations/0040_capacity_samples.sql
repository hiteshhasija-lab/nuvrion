BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Capacity forecasts (docs/capacity.md): the size and free space of each datastore, kept about every half hour for 90 days, from which the console works out how fast a datastore is
-- filling and when it will be full. Nothing else changes: no permission is added (reading needs resource.view).
CREATE TABLE IF NOT EXISTS monitoring.capacity_samples (
  object_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  connection_id uuid,
  capacity_bytes bigint NOT NULL CHECK (capacity_bytes > 0),
  free_bytes bigint NOT NULL CHECK (free_bytes >= 0 AND free_bytes <= capacity_bytes),
  PRIMARY KEY (object_id, observed_at)
);
CREATE INDEX IF NOT EXISTS capacity_samples_time_idx ON monitoring.capacity_samples (observed_at);
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0040', 'datastore capacity samples', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
