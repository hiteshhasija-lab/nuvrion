BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Threshold alerts and the notification centre (docs/alerts.md): rules ("VM CPU above 90% for 10 minutes"), the alerts they raise (one open alert per rule and target, kept
-- afterwards as history with the rule's name and the numbers it fired at), and the moment each person last read their notifications. Also the alert.manage permission.
CREATE TABLE IF NOT EXISTS monitoring.alert_rules (
  rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  description varchar(300) NOT NULL DEFAULT '',
  metric varchar(40) NOT NULL,
  comparison varchar(8) NOT NULL CHECK (comparison IN ('above', 'below')),
  threshold double precision NOT NULL CHECK (threshold >= 0),
  duration_minutes integer NOT NULL DEFAULT 0 CHECK (duration_minutes BETWEEN 0 AND 1440),
  severity varchar(8) NOT NULL CHECK (severity IN ('warning', 'critical')),
  connection_id uuid REFERENCES connections.provider_connections(connection_id),
  enabled boolean NOT NULL DEFAULT true,
  row_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_name_idx ON monitoring.alert_rules (lower(name));
CREATE TABLE IF NOT EXISTS monitoring.alerts (
  alert_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES monitoring.alert_rules(rule_id) ON DELETE SET NULL,
  rule_name varchar(100) NOT NULL,
  metric varchar(40) NOT NULL,
  comparison varchar(8) NOT NULL,
  threshold double precision NOT NULL,
  severity varchar(8) NOT NULL CHECK (severity IN ('warning', 'critical')),
  target_kind varchar(16) NOT NULL CHECK (target_kind IN ('vm', 'host', 'datastore')),
  target_id uuid NOT NULL,
  target_name varchar(256) NOT NULL,
  connection_id uuid,
  value double precision NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'acknowledged', 'resolved')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  resolved_reason varchar(24)
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_idx ON monitoring.alerts (rule_id, target_id) WHERE status IN ('active', 'acknowledged') AND rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_status_idx ON monitoring.alerts (status, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS monitoring.notification_reads (
  user_id uuid PRIMARY KEY REFERENCES identity.users(user_id),
  last_read_at timestamptz NOT NULL
);
INSERT INTO identity.permissions (permission_key, description)
VALUES ('alert.manage', 'Create, change, delete and evaluate alert rules (thresholds on CPU, memory and datastore space).')
ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO identity.role_permissions (role_id, permission_key)
SELECT role_id, 'alert.manage' FROM identity.roles WHERE normalized_name = 'platform_admin'
ON CONFLICT DO NOTHING;
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0038', 'threshold alerts and notifications', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
