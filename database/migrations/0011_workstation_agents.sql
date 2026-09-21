BEGIN;
CREATE SCHEMA IF NOT EXISTS agents;
CREATE TABLE agents.workstation_agents (
  agent_id uuid PRIMARY KEY,
  name varchar(160) NOT NULL,
  secret_hash char(64) NOT NULL,
  version varchar(32) NOT NULL,
  status varchar(24) NOT NULL CHECK(status IN ('online','offline','revoked')),
  enrolled_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz,
  revoked_at timestamptz
);
CREATE TABLE agents.enrollment_tokens (
  token_id uuid PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE,
  created_by uuid REFERENCES identity.users(user_id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE agents.commands (
  command_id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents.workstation_agents(agent_id),
  operation varchar(32) NOT NULL CHECK(operation IN ('start','stop','restart')),
  target_id varchar(1024) NOT NULL,
  nonce varchar(128) NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status varchar(24) NOT NULL CHECK(status IN ('queued','completed','failed','rejected')),
  result jsonb,
  completed_at timestamptz
);
CREATE INDEX ix_workstation_agents_heartbeat ON agents.workstation_agents(status,last_heartbeat_at);
CREATE INDEX ix_agent_commands_agent_status ON agents.commands(agent_id,status,issued_at);
COMMIT;
