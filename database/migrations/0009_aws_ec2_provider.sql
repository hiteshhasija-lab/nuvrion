BEGIN;
ALTER TABLE connections.provider_connections ADD CONSTRAINT ck_aws_region CHECK(provider_type<>'aws' OR configuration ? 'region' OR configuration->>'adapter'='mock') NOT VALID;
CREATE INDEX IF NOT EXISTS ix_resources_aws_region ON inventory.virtual_machines(region,availability_zone) WHERE region IS NOT NULL;
COMMIT;
