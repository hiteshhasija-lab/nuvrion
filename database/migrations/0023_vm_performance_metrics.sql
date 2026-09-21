BEGIN;
CREATE SCHEMA IF NOT EXISTS monitoring;
CREATE TABLE monitoring.vm_metric_samples (
  sample_id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES inventory.resources(resource_id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  cpu_utilization_percent numeric(6,3) CHECK(cpu_utilization_percent BETWEEN 0 AND 100),
  cpu_usage_mhz numeric(12,3) CHECK(cpu_usage_mhz >= 0),
  memory_utilization_percent numeric(6,3) CHECK(memory_utilization_percent BETWEEN 0 AND 100),
  memory_used_bytes bigint CHECK(memory_used_bytes >= 0),
  storage_used_bytes bigint CHECK(storage_used_bytes >= 0),
  network_rx_bytes_per_sec bigint CHECK(network_rx_bytes_per_sec >= 0),
  network_tx_bytes_per_sec bigint CHECK(network_tx_bytes_per_sec >= 0),
  source varchar(32) NOT NULL
);
CREATE INDEX ix_vm_metric_samples_resource_time ON monitoring.vm_metric_samples(resource_id,observed_at DESC);
COMMIT;
