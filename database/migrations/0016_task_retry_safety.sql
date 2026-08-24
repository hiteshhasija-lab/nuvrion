BEGIN;
ALTER TABLE operations.tasks ADD COLUMN retry_at timestamptz;
CREATE INDEX ix_tasks_retry_due ON operations.tasks(retry_at) WHERE status='queued' AND retry_at IS NOT NULL;
COMMIT;
