BEGIN;
ALTER TABLE monitoring.vm_metric_samples
  ADD COLUMN IF NOT EXISTS memory_active_bytes bigint CHECK(memory_active_bytes >= 0);
COMMIT;
