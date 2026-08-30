BEGIN;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS recovery_code_hash char(64);
COMMIT;
