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
