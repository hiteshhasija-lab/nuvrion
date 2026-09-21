BEGIN;
ALTER TABLE connections.provider_connections ADD CONSTRAINT ck_vsphere_https CHECK(provider_type<>'vmware_vsphere' OR endpoint_uri LIKE 'https://%' OR configuration->>'adapter'='mock') NOT VALID;
CREATE INDEX IF NOT EXISTS ix_resources_vsphere_native ON inventory.resources(connection_id,native_id) WHERE resource_type='virtual_machine';
COMMIT;
