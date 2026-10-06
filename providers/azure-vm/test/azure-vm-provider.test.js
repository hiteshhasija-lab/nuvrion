import test from 'node:test';
import assert from 'node:assert/strict';
import { AzureVmProvider, AzureVmProviderError } from '../src/azure-vm-provider.js';
import { defineProviderContract } from '../../test-support/provider-contract.js';

// A fake Azure Compute client. Nothing here talks to Azure: it checks our mapping, error handling and verification logic.
const id = (group, name) => `/subscriptions/sub-1/resourceGroups/${group}/providers/Microsoft.Compute/virtualMachines/${name}`;
const view = (power, provisioning = 'succeeded') => ({ statuses: [{ code: `ProvisioningState/${provisioning}` }, { code: `PowerState/${power}` }] });
const machine = (group, name, power = 'running', over = {}) => ({
  id: id(group, name), name, location: 'eastus', zones: ['1'], tags: { env: 'prod' }, provisioningState: 'Succeeded',
  hardwareProfile: { vmSize: 'Standard_D2s_v5' }, osProfile: { computerName: name.toUpperCase() },
  storageProfile: { osDisk: { osType: 'Linux', diskSizeGB: 30 }, dataDisks: [{ diskSizeGB: 100 }, { diskSizeGB: 50 }], imageReference: { offer: 'UbuntuServer' } },
  _power: power, ...over
});

function fakeClient(machines, { fail = null, stuck = false } = {}) {
  const calls = [];
  const find = (group, name) => machines.find(m => m.id === id(group, name));
  const act = (method, power) => async (group, name) => { calls.push(`${method}:${group}/${name}`); if (fail) throw fail(method); if (!stuck) find(group, name)._power = power; };
  return {
    calls,
    virtualMachines: {
      async *listAll() { if (fail) throw fail('listAll'); for (const m of machines) yield m; },
      instanceView: async (group, name) => { if (fail) throw fail('instanceView'); return view(find(group, name)._power); },
      beginStartAndWait: act('start', 'running'),
      beginDeallocateAndWait: act('deallocate', 'deallocated'),
      beginRestartAndWait: act('restart', 'running')
    }
  };
}
const providerFor = (machines = [machine('rg-a', 'web-1'), machine('rg-b', 'db-1', 'deallocated')], options) => new AzureVmProvider({ client: fakeClient(machines, options), subscriptionId: 'sub-1' });
const azureError = (statusCode, code, extra = {}) => Object.assign(new Error(`${code ?? statusCode} from Azure`), { statusCode, code, ...extra });

defineProviderContract('AzureVmProvider (fake client)', () => providerFor(), { strictReferences: true });

test('discovery maps a VM to the canonical shape, summing disk sizes and carrying provider metadata', async () => {
  const [vm] = await providerFor([machine('rg-a', 'web-1')]).discover();
  assert.equal(vm.nativeId, id('rg-a', 'web-1'));
  assert.equal(vm.name, 'web-1');
  assert.equal(vm.healthState, 'healthy');
  assert.equal(vm.attributes.powerState, 'running');
  assert.equal(vm.attributes.storageBytes, 180 * 1073741824, '30 + 100 + 50 GB');
  assert.equal(vm.attributes.region, 'eastus');
  assert.equal(vm.attributes.availabilityZone, '1');
  assert.equal(vm.attributes.providerShape, 'Standard_D2s_v5');
  assert.equal(vm.attributes.guestOs, 'Linux');
  assert.equal(vm.providerMetadata.resourceGroup, 'rg-a');
  assert.equal(vm.providerMetadata.subscriptionId, 'sub-1');
  assert.deepEqual(vm.providerMetadata.tags, { env: 'prod' });
});

test('Azure power-state codes are normalised to Nuvrion power states', async () => {
  const cases = [['running', 'running'], ['deallocated', 'stopped'], ['stopped', 'stopped'], ['starting', 'starting'], ['deallocating', 'stopping'], ['restarting', 'restarting'], ['mystery', 'mystery']];
  for (const [azure, expected] of cases) {
    const [vm] = await providerFor([machine('rg', 'vm', azure)]).discover();
    assert.equal(vm.attributes.powerState, expected, azure);
  }
});

test('provisioning state decides the health of a VM', async () => {
  const client = fakeClient([machine('rg', 'ok'), machine('rg', 'bad'), machine('rg', 'pending')]);
  client.virtualMachines.instanceView = async (group, name) => view('running', name === 'ok' ? 'succeeded' : name === 'bad' ? 'failed' : 'creating');
  const found = await new AzureVmProvider({ client, subscriptionId: 's' }).discover();
  assert.deepEqual(found.map(v => v.healthState), ['healthy', 'critical', 'unknown']);
});

test('VMs without disks or optional fields still map cleanly', async () => {
  const [vm] = await providerFor([machine('rg', 'bare', 'running', { zones: undefined, tags: undefined, storageProfile: undefined, hardwareProfile: undefined })]).discover();
  assert.equal(vm.attributes.storageBytes, 0);
  assert.equal(vm.attributes.availabilityZone, null);
  assert.equal(vm.attributes.providerShape, null);
  assert.deepEqual(vm.providerMetadata.tags, {});
});

test('stop deallocates the VM (so compute billing stops), and start and restart call the right operations', async () => {
  const machines = [machine('rg-a', 'web-1')], client = fakeClient(machines), provider = new AzureVmProvider({ client, sdk: null, subscriptionId: 'sub-1' });
  const stopped = await provider.verify((await provider.execute('stop', id('rg-a', 'web-1'))).providerReference);
  assert.equal(stopped.observedFinalState, 'stopped');
  assert.ok(client.calls.includes('deallocate:rg-a/web-1'));
  assert.equal((await provider.verify((await provider.execute('start', id('rg-a', 'web-1'))).providerReference)).observedFinalState, 'running');
  assert.equal((await provider.verify((await provider.execute('restart', id('rg-a', 'web-1'))).providerReference)).observedFinalState, 'running');
});

test('unsupported operations are refused before any request is sent', async () => {
  const client = fakeClient([machine('rg', 'vm')]), provider = new AzureVmProvider({ client, subscriptionId: 's' });
  for (const operation of ['pause', 'power_off', 'reboot_guest', 'delete']) {
    await assert.rejects(() => provider.execute(operation, id('rg', 'vm')), e => e.code === 'NUV_OPERATION_UNSUPPORTED');
  }
  assert.equal(client.calls.length, 0);
});

test('a malformed resource ID is rejected clearly, before calling Azure', async () => {
  const client = fakeClient([]), provider = new AzureVmProvider({ client, subscriptionId: 's' });
  for (const bad of ['', 'i-12345', '/subscriptions/s/resourceGroups/rg', undefined]) {
    await assert.rejects(() => provider.execute('start', bad), e => e.code === 'NUV_AZURE_RESOURCE_ID_INVALID', String(bad));
  }
  assert.equal(client.calls.length, 0);
});

test('resource group and VM names are URL-decoded from the resource ID', async () => {
  const encoded = '/subscriptions/s/resourceGroups/my%20group/providers/Microsoft.Compute/virtualMachines/vm%2D1';
  const machines = [{ ...machine('my group', 'vm-1'), id: encoded }];
  const client = fakeClient(machines);
  client.virtualMachines.beginStartAndWait = async (group, name) => { client.calls.push(`${group}|${name}`); };
  await new AzureVmProvider({ client, subscriptionId: 's' }).execute('start', encoded);
  assert.deepEqual(client.calls, ['my group|vm-1']);
});

test('verification that sees the wrong state is a retryable "pending" error, so it is reconciled rather than failed', async () => {
  const provider = providerFor([machine('rg', 'vm')], { stuck: true });
  const { providerReference } = await provider.execute('stop', id('rg', 'vm'));
  await assert.rejects(() => provider.verify(providerReference), e => e.code === 'NUV_AZURE_VERIFICATION_PENDING' && e.retryable === true && /Expected stopped, observed running/.test(e.message));
});

test('Azure errors are mapped to stable codes with the right retry behaviour', async () => {
  const cases = [
    [azureError(401, 'InvalidAuthenticationToken'), 'NUV_AZURE_AUTH_FAILED', false],
    [azureError(undefined, 'AuthenticationFailed'), 'NUV_AZURE_AUTH_FAILED', false],
    [azureError(403, 'AuthorizationFailed'), 'NUV_AZURE_PERMISSION_DENIED', false],
    [azureError(404, 'ResourceNotFound'), 'NUV_AZURE_RESOURCE_NOT_FOUND', false],
    [azureError(429, 'TooManyRequests'), 'NUV_AZURE_THROTTLED', true],
    [azureError(408), 'NUV_AZURE_UNAVAILABLE', true],
    [azureError(500), 'NUV_AZURE_UNAVAILABLE', true],
    [azureError(503, 'ServiceUnavailable'), 'NUV_AZURE_UNAVAILABLE', true],
    [azureError(400, 'BadRequest'), 'NUV_AZURE_REQUEST_FAILED', false]
  ];
  for (const [error, code, retryable] of cases) {
    const provider = providerFor([machine('rg', 'vm')], { fail: () => error });
    await assert.rejects(() => provider.discover(), e => e instanceof AzureVmProviderError && e.code === code && e.retryable === retryable, `${error.statusCode ?? error.code} → ${code}`);
  }
});

test('an error during an operation keeps its mapped code and does not create a verifiable reference', async () => {
  const provider = providerFor([machine('rg', 'vm')], { fail: () => azureError(403, 'AuthorizationFailed') });
  await assert.rejects(() => provider.execute('stop', id('rg', 'vm')), e => e.code === 'NUV_AZURE_PERMISSION_DENIED');
  await assert.rejects(() => provider.verify('azure:none'), e => e.code === 'NUV_AZURE_REFERENCE_INVALID');
});

test('the connection test succeeds against a healthy API and surfaces permission problems clearly', async () => {
  assert.deepEqual(await providerFor().testConnection(), { status: 'healthy', provider: 'azure', subscriptionId: 'sub-1', api: 'Azure Compute' });
  await assert.rejects(() => providerFor([], { fail: () => azureError(403, 'AuthorizationFailed') }).testConnection(), e => e.code === 'NUV_AZURE_PERMISSION_DENIED');
});

test('creating a provider requires the full service-principal credential and a subscription', async () => {
  await assert.rejects(() => AzureVmProvider.create({ credential: { tenantId: 't', clientId: 'c' }, subscriptionId: 's' }), e => e.code === 'NUV_AZURE_CREDENTIAL_REQUIRED');
  await assert.rejects(() => AzureVmProvider.create({ credential: { tenantId: 't', clientSecret: 's' }, subscriptionId: 's' }), e => e.code === 'NUV_AZURE_CREDENTIAL_REQUIRED');
  await assert.rejects(() => AzureVmProvider.create({ credential: undefined, subscriptionId: 's' }), e => e.code === 'NUV_AZURE_CREDENTIAL_REQUIRED');
  await assert.rejects(() => AzureVmProvider.create({ credential: { tenantId: 't', clientId: 'c', clientSecret: 's' } }), e => e.code === 'NUV_AZURE_SUBSCRIPTION_REQUIRED');
});
