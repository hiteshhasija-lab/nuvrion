BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Scheduled operations (docs/schedules.md): schedules (an operation on listed machines or on the machines with a tag, once or daily or on chosen weekdays, in a time zone) and
-- a history of what each run did. Also the schedule.manage permission, for administrators and operators.
CREATE TABLE IF NOT EXISTS operations.schedules (
  schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  description varchar(300) NOT NULL DEFAULT '',
  operation varchar(16) NOT NULL CHECK (operation IN ('start', 'stop', 'power_off', 'pause', 'reboot_guest', 'restart')),
  target_kind varchar(8) NOT NULL CHECK (target_kind IN ('vms', 'tag')),
  vm_ids uuid[] NOT NULL DEFAULT '{}',
  tag varchar(200),
  connection_id uuid REFERENCES connections.provider_connections(connection_id),
  frequency varchar(8) NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly')),
  time_of_day varchar(5) NOT NULL CHECK (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  weekdays smallint[] NOT NULL DEFAULT '{}',
  run_date date,
  time_zone varchar(64) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_outcome varchar(16),
  created_by uuid,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_targets_match_kind CHECK ((target_kind = 'vms' AND cardinality(vm_ids) BETWEEN 1 AND 50 AND tag IS NULL) OR (target_kind = 'tag' AND tag IS NOT NULL AND cardinality(vm_ids) = 0)),
  CONSTRAINT schedules_when_matches_frequency CHECK ((frequency = 'once' AND run_date IS NOT NULL AND cardinality(weekdays) = 0) OR (frequency = 'daily' AND run_date IS NULL AND cardinality(weekdays) = 0) OR (frequency = 'weekly' AND run_date IS NULL AND cardinality(weekdays) BETWEEN 1 AND 7))
);
CREATE UNIQUE INDEX IF NOT EXISTS schedules_name_idx ON operations.schedules (lower(name));
CREATE INDEX IF NOT EXISTS schedules_due_idx ON operations.schedules (next_run_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS operations.schedule_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid REFERENCES operations.schedules(schedule_id) ON DELETE SET NULL,
  schedule_name varchar(100) NOT NULL,
  operation varchar(16) NOT NULL,
  trigger varchar(10) NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome varchar(16) NOT NULL CHECK (outcome IN ('completed', 'partial', 'failed', 'skipped', 'missed', 'error')),
  matched integer NOT NULL DEFAULT 0,
  submitted integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  details_truncated boolean NOT NULL DEFAULT false,
  error text,
  requested_by uuid
);
CREATE INDEX IF NOT EXISTS schedule_runs_schedule_idx ON operations.schedule_runs (schedule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS schedule_runs_started_idx ON operations.schedule_runs (started_at DESC);
INSERT INTO identity.permissions (permission_key, description)
VALUES ('schedule.manage', 'Create, change, delete and run schedules that power machines on and off, restart or suspend them (needs resource.operate).')
ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO identity.role_permissions (role_id, permission_key)
SELECT role_id, 'schedule.manage' FROM identity.roles WHERE normalized_name IN ('platform_admin', 'operator')
ON CONFLICT DO NOTHING;
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0039', 'scheduled operations', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
