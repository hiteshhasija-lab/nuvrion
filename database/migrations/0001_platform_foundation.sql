BEGIN;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS operations;
CREATE TABLE IF NOT EXISTS platform.schema_migrations (
  version varchar(32) PRIMARY KEY, description varchar(240) NOT NULL,
  checksum varchar(128) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operations.tasks (
  task_id uuid PRIMARY KEY, operation varchar(64) NOT NULL,
  status varchar(32) NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','verification_required')),
  target_id varchar(1024) NOT NULL, correlation_id uuid NOT NULL,
  queued_at timestamptz NOT NULL, started_at timestamptz, completed_at timestamptz,
  result_summary jsonb, error_summary jsonb
);
CREATE INDEX IF NOT EXISTS ix_tasks_status_queued ON operations.tasks(status, queued_at);
COMMIT;
