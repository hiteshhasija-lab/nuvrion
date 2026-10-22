BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy.
-- Webhooks (docs/webhooks.md): where Nuvrion sends alerts and failed schedule runs, and the queue of what was sent. The address of a webhook usually carries a secret (a token in the
-- path), so it is stored encrypted with the platform's key ring, like a provider credential, and is never returned by the API.
CREATE TABLE IF NOT EXISTS monitoring.webhook_destinations (
  destination_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  format varchar(12) NOT NULL CHECK (format IN ('json', 'text', 'discord')),
  events text[] NOT NULL,
  min_severity varchar(8) NOT NULL CHECK (min_severity IN ('warning', 'critical')),
  enabled boolean NOT NULL DEFAULT true,
  active_since timestamptz NOT NULL DEFAULT now(),
  url_hint varchar(300) NOT NULL,
  secret_key_id varchar(64) NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_tag bytea NOT NULL,
  has_signing_secret boolean NOT NULL DEFAULT false,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error varchar(300),
  row_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_destinations_name_idx ON monitoring.webhook_destinations (lower(name));
CREATE TABLE IF NOT EXISTS monitoring.webhook_deliveries (
  delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid REFERENCES monitoring.webhook_destinations(destination_id) ON DELETE CASCADE,
  destination_name varchar(100) NOT NULL,
  event_id varchar(120) NOT NULL,
  event_type varchar(32) NOT NULL,
  severity varchar(8) NOT NULL,
  title varchar(300) NOT NULL,
  detail varchar(1000) NOT NULL DEFAULT '',
  occurred_at timestamptz NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  response_status integer,
  error varchar(300),
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_event_idx ON monitoring.webhook_deliveries (destination_id, event_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON monitoring.webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON monitoring.webhook_deliveries (created_at DESC);
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0041', 'webhook destinations and deliveries', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
