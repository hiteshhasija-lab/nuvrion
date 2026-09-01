BEGIN;
ALTER TABLE connections.provider_connections
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  ADD COLUMN last_error_code varchar(128),
  ADD COLUMN next_retry_at timestamptz;
CREATE INDEX ix_provider_connections_retry ON connections.provider_connections(next_retry_at)
  WHERE status='enabled' AND next_retry_at IS NOT NULL;
COMMIT;
