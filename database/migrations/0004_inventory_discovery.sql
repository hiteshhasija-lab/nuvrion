BEGIN;
CREATE TABLE inventory.discovery_runs (
  discovery_run_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections.provider_connections(connection_id),
  status varchar(24) NOT NULL CHECK(status IN ('running','completed','failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  discovered_count integer NOT NULL DEFAULT 0 CHECK(discovered_count >= 0),
  created_count integer NOT NULL DEFAULT 0 CHECK(created_count >= 0),
  updated_count integer NOT NULL DEFAULT 0 CHECK(updated_count >= 0),
  missing_count integer NOT NULL DEFAULT 0 CHECK(missing_count >= 0),
  error_code varchar(128)
);
CREATE INDEX ix_discovery_runs_connection_started ON inventory.discovery_runs(connection_id, started_at DESC);
COMMIT;
