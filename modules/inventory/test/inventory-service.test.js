import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/inventory-service.js';

const connection = { id: 'c1', providerType: 'vmware_workstation' };
const vm = (nativeId, name) => ({ resourceType: 'virtual_machine', nativeId, name, attributes: { powerState: 'stopped' } });
const stateOf = (inventory, name) => inventory.list({ connectionId: 'c1' }).find(resource => resource.name === name)?.lifecycleState;

test('an observed resource that disappears becomes missing', () => {
  const inventory = new InventoryService();
  inventory.synchronize(connection, [vm('a', 'A'), vm('b', 'B')]);
  inventory.synchronize(connection, [vm('a', 'A')]);
  assert.equal(stateOf(inventory, 'B'), 'missing');
  assert.equal(stateOf(inventory, 'A'), 'active');
});

test('a retired connection\'s resources stay deleted across later discovery runs', () => {
  const inventory = new InventoryService();
  inventory.synchronize(connection, [vm('a', 'A')]);
  assert.equal(inventory.retireConnection('c1'), 1);
  inventory.synchronize(connection, []);
  inventory.synchronize(connection, []);
  assert.equal(stateOf(inventory, 'A'), 'deleted');
});

test('a deleted resource that reappears at the same native id is revived', () => {
  const inventory = new InventoryService();
  inventory.synchronize(connection, [vm('a', 'A')]);
  inventory.retireConnection('c1');
  inventory.synchronize(connection, [vm('a', 'A')]);
  assert.equal(stateOf(inventory, 'A'), 'active');
});

// When the connection stops answering, the power state kept for a VM is a memory. The service must say so and must not use it to refuse an operation.
const runningVm = (nativeId, name) => ({ resourceType: 'virtual_machine', nativeId, name, attributes: { powerState: 'running' }, providerMetadata: { toolsStatus: 'Running' } });

test('while the connection is healthy a running VM cannot be started, and an unreachable connection makes its power state unknown and allows the operation', () => {
  let health = { healthState: 'healthy' };
  const inventory = new InventoryService({ connectionHealth: id => id === 'c1' ? health : null });
  inventory.synchronize(connection, [runningVm('a', 'A')]);
  const id = inventory.list({ connectionId: 'c1' })[0].id;
  assert.equal(inventory.get(id).attributes.powerState, 'running');
  assert.deepEqual([inventory.validateOperation(id, 'start').ok, inventory.validateOperation(id, 'start').code], [false, 'NUV_OPERATION_STATE_CONFLICT']);

  health = { healthState: 'critical', lastErrorCode: 'NUV_AGENT_OFFLINE' };
  const stale = inventory.get(id);
  assert.deepEqual([stale.attributes.powerState, stale.attributes.lastKnownPowerState, stale.observation.state, stale.observation.reason], ['unknown', 'running', 'stale', 'NUV_AGENT_OFFLINE']);
  assert.equal(inventory.list({ connectionId: 'c1' })[0].attributes.powerState, 'unknown', 'the list says the same as the single resource');
  assert.equal(inventory.validateOperation(id, 'start').ok, true, 'a stale "running" does not stop a person from powering the VM on');
  assert.equal(inventory.validateOperation(id, 'power_off').ok, true);

  health = { healthState: 'healthy' };
  assert.equal(inventory.get(id).attributes.powerState, 'running', 'when the connection recovers the observed state is back');
  assert.equal(inventory.validateOperation(id, 'start').ok, false);
});

test('the stored power state itself is not overwritten by being presented as unknown', () => {
  let health = { healthState: 'critical' };
  const inventory = new InventoryService({ connectionHealth: () => health });
  inventory.synchronize(connection, [runningVm('a', 'A')]);
  const id = inventory.list()[0].id;
  assert.equal(inventory.get(id).attributes.powerState, 'unknown');
  health = { healthState: 'healthy' };
  assert.equal(inventory.get(id).attributes.powerState, 'running');
});

test('a service without a connection lookup treats every VM as observed', () => {
  const inventory = new InventoryService();
  inventory.synchronize(connection, [runningVm('a', 'A')]);
  const vm = inventory.list()[0];
  assert.deepEqual([vm.observation.state, vm.attributes.powerState], ['live', 'running']);
});
