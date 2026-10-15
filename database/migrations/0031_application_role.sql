BEGIN;
-- The application role. Until now the API connected as the database's superuser, which could do anything in the database server (create and drop objects, read
-- server files, run commands with COPY ... TO PROGRAM). The application needs none of that: it reads and writes rows. This migration defines a group role,
-- nuvrion_app, that holds exactly what the application code does, and a login role that is a member of it is what the API should connect as. The login role
-- carries the password and so is created by the operator (deploy/application-role.sh), not by a migration. Migrations keep running as the owner.
--
--   - rows of the operational tables: select, insert, update, delete (retention prunes samples, health events and discovery runs; sessions, tasks and the
--     rest are updated in place)
--   - audit.audit_events: select and insert only. The audit trail is append-only for the application now, which the database enforces
--   - platform.schema_migrations: select only (readiness compares it with the migrations that ship); only a migration writes it
--   - no create, drop, truncate, trigger or reference rights, and no rights on objects that are added later unless a migration grants them
--
-- Idempotent: the upgrade script applies the release's newest migration at every deploy, and the role is cluster-wide while a database may be rebuilt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuvrion_app') THEN
    BEGIN
      CREATE ROLE nuvrion_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN
      NULL;   -- another database on this server created it a moment ago
    END;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA agents, audit, connections, identity, inventory, monitoring, operations, platform TO nuvrion_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agents, connections, identity, inventory, monitoring, operations TO nuvrion_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO nuvrion_app;
GRANT SELECT ON ALL TABLES IN SCHEMA platform TO nuvrion_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA audit FROM nuvrion_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA platform FROM nuvrion_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agents, audit, connections, identity, inventory, monitoring, operations, platform TO nuvrion_app;

-- Tables a later migration creates (as the role that runs migrations) get the same rights without another grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA agents, connections, identity, inventory, monitoring, operations GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nuvrion_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO nuvrion_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT SELECT ON TABLES TO nuvrion_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agents, audit, connections, identity, inventory, monitoring, operations, platform GRANT USAGE, SELECT ON SEQUENCES TO nuvrion_app;

INSERT INTO platform.schema_migrations (version, description, checksum)
VALUES ('0031', 'application role', 'self-recorded')
ON CONFLICT (version) DO NOTHING;
COMMIT;
