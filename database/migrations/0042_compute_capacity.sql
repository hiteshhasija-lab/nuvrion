BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Capacity of hosts and clusters (docs/capacity.md): the same readings table now also holds processor and memory readings (capacity_bytes and free_bytes are then MHz or bytes of the metric named
-- in `metric`), and an alert may be about a cluster.
ALTER TABLE monitoring.capacity_samples ADD COLUMN IF NOT EXISTS metric varchar(8) NOT NULL DEFAULT 'storage';
ALTER TABLE monitoring.capacity_samples DROP CONSTRAINT IF EXISTS capacity_samples_metric_check;
ALTER TABLE monitoring.capacity_samples ADD CONSTRAINT capacity_samples_metric_check CHECK (metric IN ('storage', 'cpu', 'memory'));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                 WHERE i.indrelid = 'monitoring.capacity_samples'::regclass AND i.indisprimary AND a.attname = 'metric') THEN
    ALTER TABLE monitoring.capacity_samples DROP CONSTRAINT capacity_samples_pkey;
    ALTER TABLE monitoring.capacity_samples ADD PRIMARY KEY (object_id, metric, observed_at);
  END IF;
END $$;
ALTER TABLE monitoring.alerts DROP CONSTRAINT IF EXISTS alerts_target_kind_check;
ALTER TABLE monitoring.alerts ADD CONSTRAINT alerts_target_kind_check CHECK (target_kind IN ('vm', 'host', 'datastore', 'cluster'));
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0042', 'capacity of hosts and clusters', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
