BEGIN;
ALTER TABLE agents.upgrade_releases ADD COLUMN signing_key_id varchar(64) NOT NULL;
CREATE INDEX ix_agent_upgrade_releases_version ON agents.upgrade_releases(version,created_at DESC);
COMMIT;
