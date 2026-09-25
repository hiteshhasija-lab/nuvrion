BEGIN;
CREATE TABLE agents.upgrade_releases (
  release_id uuid PRIMARY KEY,
  version varchar(32) NOT NULL,
  artifact_url text NOT NULL CHECK(artifact_url LIKE 'https://%'),
  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes > 0),
  manifest_signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agents.upgrade_deployments (
  deployment_id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents.workstation_agents(agent_id),
  release_id uuid NOT NULL REFERENCES agents.upgrade_releases(release_id),
  status varchar(24) NOT NULL CHECK(status IN ('staged','downloading','ready','installed','failed','rolled_back')),
  staged_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rollback_version varchar(32),
  detail jsonb
);
CREATE INDEX ix_agent_upgrade_deployments_agent ON agents.upgrade_deployments(agent_id,staged_at DESC);
COMMIT;
