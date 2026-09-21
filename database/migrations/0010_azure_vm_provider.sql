BEGIN;
ALTER TABLE connections.provider_connections ADD CONSTRAINT ck_azure_subscription CHECK(provider_type<>'azure' OR configuration ? 'subscriptionId' OR configuration->>'adapter'='mock') NOT VALID;
CREATE INDEX IF NOT EXISTS ix_resources_azure_location ON inventory.virtual_machines(region,availability_zone) WHERE region IS NOT NULL;
COMMIT;
