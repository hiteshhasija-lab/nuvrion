BEGIN;
ALTER TABLE agents.commands DROP CONSTRAINT IF EXISTS commands_operation_check;
ALTER TABLE agents.commands ADD CONSTRAINT commands_operation_check
  CHECK(operation IN ('start','stop','restart','pause','console'));
COMMIT;
