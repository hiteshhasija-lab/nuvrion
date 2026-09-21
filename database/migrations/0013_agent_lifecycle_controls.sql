BEGIN;
ALTER TABLE agents.workstation_agents ADD COLUMN secret_rotated_at timestamptz;
ALTER TABLE agents.workstation_agents ADD COLUMN revocation_reason varchar(256);
CREATE INDEX ix_agent_commands_expiry ON agents.commands(expires_at) WHERE status='queued';
COMMIT;
