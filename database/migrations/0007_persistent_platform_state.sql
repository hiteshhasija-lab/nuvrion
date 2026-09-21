BEGIN;
CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON identity.sessions(idle_expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_resources_native_search ON inventory.resources(lower(native_id));
CREATE INDEX IF NOT EXISTS ix_resources_name_search ON inventory.resources(lower(name));
CREATE INDEX IF NOT EXISTS ix_connections_health ON connections.provider_connections(status,health_state);
COMMIT;
