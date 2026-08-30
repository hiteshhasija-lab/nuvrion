BEGIN;
ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE identity.users ADD CONSTRAINT users_status_check CHECK(status IN ('active','pending','locked','disabled'));
COMMIT;
