BEGIN;
-- Idempotent: the upgrade script applies the release's newest migration at every deploy. Per-agent policy for automatic upgrades. Off by default: an agent is only upgraded without a click when an administrator turns this on for it.
-- The window is optional (both ends or neither), in the named IANA time zone; a window whose end is earlier than its start crosses midnight.
CREATE TABLE IF NOT EXISTS agents.upgrade_policies (
  agent_id uuid PRIMARY KEY REFERENCES agents.workstation_agents(agent_id) ON DELETE CASCADE,
  auto_upgrade boolean NOT NULL DEFAULT false,
  window_start varchar(5) CHECK (window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  window_end varchar(5) CHECK (window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  window_timezone varchar(64) NOT NULL DEFAULT 'UTC',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by varchar(128),
  CHECK ((window_start IS NULL) = (window_end IS NULL))
);
INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0030', 'agent upgrade policies', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
