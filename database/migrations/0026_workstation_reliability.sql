BEGIN;
ALTER TABLE agents.workstation_agents
  ADD COLUMN IF NOT EXISTS diagnostics jsonb;
ALTER TABLE agents.commands DROP CONSTRAINT IF EXISTS commands_operation_check;
ALTER TABLE agents.commands ADD CONSTRAINT commands_operation_check
  CHECK(operation IN ('start','stop','power_off','restart','pause','console','media.browse','media.mount','media.eject'));
COMMIT;
