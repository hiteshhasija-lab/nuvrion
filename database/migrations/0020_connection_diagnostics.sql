BEGIN;
CREATE TABLE connections.health_events (
  event_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections.provider_connections(connection_id) ON DELETE CASCADE,
  check_type varchar(32) NOT NULL CHECK(check_type IN ('test','discovery','scheduled_discovery')),
  outcome varchar(16) NOT NULL CHECK(outcome IN ('succeeded','failed')),
  error_code varchar(128),
  duration_ms integer NOT NULL CHECK(duration_ms >= 0),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_connection_health_events_recent ON connections.health_events(connection_id,checked_at DESC);
COMMIT;
