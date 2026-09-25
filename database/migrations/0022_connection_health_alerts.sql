BEGIN;
CREATE TABLE connections.health_alerts (
  alert_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections.provider_connections(connection_id) ON DELETE CASCADE,
  severity varchar(16) NOT NULL CHECK(severity IN ('unhealthy','critical')),
  status varchar(16) NOT NULL CHECK(status IN ('active','acknowledged','recovered')),
  error_code varchar(128) NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK(occurrence_count > 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES identity.users(user_id),
  recovered_at timestamptz
);
CREATE UNIQUE INDEX ux_connection_health_alert_active ON connections.health_alerts(connection_id)
  WHERE status IN ('active','acknowledged');
CREATE INDEX ix_connection_health_alerts_recent ON connections.health_alerts(opened_at DESC);
COMMIT;
