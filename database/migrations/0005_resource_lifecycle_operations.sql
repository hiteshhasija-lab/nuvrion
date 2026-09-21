BEGIN;
ALTER TABLE operations.tasks ADD COLUMN IF NOT EXISTS connection_id uuid REFERENCES connections.provider_connections(connection_id);
ALTER TABLE operations.tasks ADD COLUMN IF NOT EXISTS provider_native_id varchar(1024);
ALTER TABLE operations.tasks ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES identity.users(user_id);
CREATE INDEX ix_tasks_active_resource ON operations.tasks(target_id, status) WHERE status IN ('queued','running');
ALTER TABLE inventory.virtual_machines ADD COLUMN IF NOT EXISTS last_operation varchar(32);
ALTER TABLE inventory.virtual_machines ADD COLUMN IF NOT EXISTS last_operation_at timestamptz;
COMMIT;
