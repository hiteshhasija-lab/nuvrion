BEGIN;
ALTER TABLE operations.tasks ADD COLUMN IF NOT EXISTS target_type varchar(64) NOT NULL DEFAULT 'virtual_machine';
ALTER TABLE operations.tasks ADD COLUMN IF NOT EXISTS requested_by_name varchar(128);
ALTER TABLE operations.tasks ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{"current":0,"total":1,"messageCode":"NUV_TASK_QUEUED"}';
ALTER TABLE operations.tasks ADD COLUMN IF NOT EXISTS provider_reference varchar(1024);
CREATE INDEX IF NOT EXISTS ix_task_leases_expiry ON operations.task_leases(expires_at);
COMMIT;
