import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { InventoryService } from '../modules/inventory/src/inventory-service.js';

const connection = { id:'11111111-1111-4111-8111-111111111111', providerType:'mock' };
const vm = (nativeId, name='vm-one') => ({ resourceType:'virtual_machine', nativeId, name, healthState:'healthy', attributes:{powerState:'running'}, providerMetadata:{native:true} });

test('inventory sync upserts stable identities and marks missing resources',()=>{
  const inventory=new InventoryService();
  const first=inventory.synchronize(connection,[vm('vm-1'),vm('vm-2','vm-two')]);
  assert.deepEqual({created:first.created,updated:first.updated,missing:first.missing},{created:2,updated:0,missing:0});
  const original=inventory.list({search:'vm-one'})[0];
  const second=inventory.synchronize(connection,[vm('vm-1','vm-one-renamed')]);
  assert.deepEqual({created:second.created,updated:second.updated,missing:second.missing},{created:0,updated:1,missing:1});
  assert.equal(inventory.list({search:'renamed'})[0].id,original.id);
  assert.equal(inventory.list({lifecycleState:'missing'})[0].nativeId,'vm-2');
});

test('inventory survives restart and preserves provider metadata',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'nuvrion-inventory-')),'inventory.json');
  new InventoryService({file}).synchronize(connection,[vm('vm-durable')]);
  const resource=new InventoryService({file}).list()[0];
  assert.equal(resource.attributes.powerState,'running');
  assert.equal(resource.providerMetadata.native,true);
  assert.match(resource.providerMetadataHash,/^[0-9a-f]{64}$/);
});

test('lifecycle validation and verified state updates are enforced',()=>{
  const inventory=new InventoryService();inventory.synchronize(connection,[vm('vm-lifecycle')]);const resource=inventory.list()[0];
  assert.equal(inventory.validateOperation(resource.id,'stop').ok,true);
  inventory.applyOperation(resource.id,'stop',{code:'NUV_OPERATION_VERIFIED',observedFinalState:'stopped'});
  assert.equal(inventory.get(resource.id).attributes.powerState,'stopped');
  assert.equal(inventory.validateOperation(resource.id,'restart').code,'NUV_OPERATION_STATE_CONFLICT');
  assert.equal(inventory.validateOperation(resource.id,'start').ok,true);
});
