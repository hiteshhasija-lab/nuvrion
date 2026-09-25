BEGIN;
ALTER TABLE agents.workstation_agents ADD COLUMN secret_nonce bytea;
ALTER TABLE agents.workstation_agents ADD COLUMN secret_ciphertext bytea;
ALTER TABLE agents.workstation_agents ADD COLUMN secret_auth_tag bytea;
ALTER TABLE agents.workstation_agents ADD COLUMN inventory jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents.workstation_agents ADD CONSTRAINT ck_agent_encrypted_secret CHECK(
  (status = 'revoked') OR (secret_nonce IS NOT NULL AND secret_ciphertext IS NOT NULL AND secret_auth_tag IS NOT NULL)
);
COMMIT;
