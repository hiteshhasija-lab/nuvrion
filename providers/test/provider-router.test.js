import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRouter, correlateNestedEsxiHostnames } from '../provider-router.js';
import { MockProvider } from '../mock/src/mock-provider.js';
import { EsxiProvider } from '../vmware-esxi/src/esxi-provider.js';
import { VsphereProvider } from '../vmware-vsphere/src/vsphere-provider.js';
import { WorkstationAgentProvider } from '../vmware-workstation-agent/src/workstation-agent-provider.js';
import { workstationLab, sampleWorkstationVm } from '../test-support/fake-workstation-agent.js';

// The router picks the adapter for a connection, keeps one media / snapshot / settings change at a time per VM, and answers "unsupported" for providers that lack a feature.
const CREDENTIAL = { username: 'root', password: 'not-a-real-password' }; // secret-scan:allow (fake test credential)
const connections = (list = []) => ({ list: async () => list, get: async id => list.find(c => c.id === id) ?? null, resolveCredential: async () => CREDENTIAL, recordTrustPin: async () => {} });
const mockConnection = { id: 'c-mock', providerType: 'mock', connectionType: 'mock', configuration: { adapter: 'mock' } };
const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };

test('the adapter is chosen from the connection: mock, Workstation agent, ESXi, vCenter', async () => {
  const lab = workstationLab(), router = new ProviderRouter({ connections: connections(), agents: lab.registry, fetchImpl: async () => { throw new Error('no network in tests'); } });
  assert.ok(await router.forConnection(mockConnection) instanceof MockProvider);
  const agent = await router.forConnection({ id: 'c1', providerType: 'vmware_workstation', connectionType: 'workstation_agent', configuration: { agentId: lab.agentId, verificationAttempts: '7', verificationIntervalMs: '3' } });
  assert.ok(agent instanceof WorkstationAgentProvider);
  assert.deepEqual([agent.attempts, agent.interval], [7, 3]);
  assert.ok(await router.forConnection({ id: 'c2', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://vc.example/', configuration: {} }) instanceof VsphereProvider);
  const esxi = await router.forConnection({ id: 'c3', providerType: 'vmware_vsphere', connectionType: 'esxi', endpointUri: 'https://esxi.example/', configuration: { tlsCertificateSha256: 'a'.repeat(64), sshHostKeySha256: 'b'.repeat(64) } });
  assert.ok(esxi instanceof EsxiProvider);
});

test('a Workstation agent connection without an agent registry fails clearly instead of crashing', async () => {
  const router = new ProviderRouter({ connections: connections() });
  await assert.rejects(() => router.forConnection({ id: 'c1', providerType: 'vmware_workstation', connectionType: 'workstation_agent', configuration: { agentId: 'a' } }), e => e.code === 'NUV_AGENT_REGISTRY_UNAVAILABLE');
});

test('features a provider does not have are refused with a 422 and a specific code', async () => {
  const bare = { discover: async () => [], execute: async () => ({ providerReference: 'r' }), verify: async () => ({}) };
  const router = new ProviderRouter({ connections: connections(), mock: bare });
  const connection = { id: 'c1', configuration: { adapter: 'mock' } };
  const cases = [[() => router.console(connection, 'vm'), 'NUV_CONSOLE_UNSUPPORTED'], [() => router.media(connection, 'vm'), 'NUV_MEDIA_UNSUPPORTED'], [() => router.browseMedia(connection, {}), 'NUV_MEDIA_BROWSE_UNSUPPORTED'], [() => router.mountMedia(connection, 'vm', {}), 'NUV_MEDIA_UNSUPPORTED'], [() => router.ejectMedia(connection, 'vm', {}), 'NUV_MEDIA_UNSUPPORTED'], [() => router.snapshots(connection, 'vm'), 'NUV_SNAPSHOT_UNSUPPORTED'], [() => router.createSnapshot(connection, 'vm', {}), 'NUV_SNAPSHOT_UNSUPPORTED'], [() => router.revertSnapshot(connection, 'vm', 's'), 'NUV_SNAPSHOT_UNSUPPORTED'], [() => router.deleteSnapshot(connection, 'vm', 's'), 'NUV_SNAPSHOT_UNSUPPORTED'], [() => router.settings(connection, 'vm'), 'NUV_VM_SETTINGS_UNSUPPORTED'], [() => router.updateSettings(connection, 'vm', {}), 'NUV_VM_SETTINGS_UNSUPPORTED']];
  for (const [call, code] of cases) await assert.rejects(call, e => e.code === code && e.status === 422, code);
  assert.equal(await router.hostIdentity(connection), null);
  assert.deepEqual(await router.test(connection), { status: 'healthy', provider: 'mock' });
});

test('only one media change per VM runs at a time; another VM and later requests are unaffected, and a failure frees the lock', async () => {
  const hold = gate(), calls = [];
  const slow = { mountMedia: async (vm, input) => { calls.push(vm); await hold.wait; if (input.fail) throw new Error('boom'); return { ok: vm }; }, ejectMedia: async () => ({ ok: true }) };
  const router = new ProviderRouter({ connections: connections(), mock: slow }), connection = { id: 'c1', configuration: { adapter: 'mock' } };
  const first = router.mountMedia(connection, 'vm-1', {});
  await assert.rejects(() => router.mountMedia(connection, 'vm-1', {}), e => e.code === 'NUV_MEDIA_OPERATION_IN_PROGRESS' && e.status === 409);
  await assert.rejects(() => router.ejectMedia(connection, 'vm-1', {}), e => e.code === 'NUV_MEDIA_OPERATION_IN_PROGRESS', 'mount and eject share one lock');
  const other = router.mountMedia(connection, 'vm-2', {}), otherConnection = router.mountMedia({ id: 'c2', configuration: { adapter: 'mock' } }, 'vm-1', {});
  hold.release();
  assert.deepEqual(await Promise.all([first, other, otherConnection]), [{ ok: 'vm-1' }, { ok: 'vm-2' }, { ok: 'vm-1' }]);
  await assert.rejects(() => router.mountMedia(connection, 'vm-1', { fail: true }), /boom/);
  assert.deepEqual(await router.mountMedia(connection, 'vm-1', {}), { ok: 'vm-1' }, 'a failed change does not leave the VM locked');
});

test('snapshot and settings changes are likewise one at a time per VM, and free their lock when they fail', async () => {
  const hold = gate();
  const slow = { createSnapshot: async (vm, input) => { await hold.wait; if (input?.fail) throw new Error('snapshot failed'); return { created: vm }; }, revertSnapshot: async () => ({}), deleteSnapshot: async () => ({}), updateSettings: async (vm, input) => { await hold.wait; if (input?.fail) throw new Error('settings failed'); return { updated: vm }; } };
  const router = new ProviderRouter({ connections: connections(), mock: slow }), connection = { id: 'c1', configuration: { adapter: 'mock' } };
  const snapshot = router.createSnapshot(connection, 'vm-1', {}), settings = router.updateSettings(connection, 'vm-1', {});
  await assert.rejects(() => router.revertSnapshot(connection, 'vm-1', 's'), e => e.code === 'NUV_SNAPSHOT_OPERATION_IN_PROGRESS' && e.status === 409);
  await assert.rejects(() => router.deleteSnapshot(connection, 'vm-1', 's'), e => e.code === 'NUV_SNAPSHOT_OPERATION_IN_PROGRESS');
  await assert.rejects(() => router.updateSettings(connection, 'vm-1', {}), e => e.code === 'NUV_VM_SETTINGS_IN_PROGRESS' && e.status === 409);
  hold.release();
  assert.deepEqual(await Promise.all([snapshot, settings]), [{ created: 'vm-1' }, { updated: 'vm-1' }]);
  await assert.rejects(() => router.createSnapshot(connection, 'vm-1', { fail: true }), /snapshot failed/);
  await assert.rejects(() => router.updateSettings(connection, 'vm-1', { fail: true }), /settings failed/);
  assert.deepEqual(await router.createSnapshot(connection, 'vm-1', {}), { created: 'vm-1' });
  assert.deepEqual(await router.updateSettings(connection, 'vm-1', {}), { updated: 'vm-1' });
});

test('execute remembers which adapter accepted the operation, so verify asks the same one, and forgets it afterwards', async () => {
  const lab = workstationLab(), router = new ProviderRouter({ connections: connections([{ id: 'c1', providerType: 'vmware_workstation', connectionType: 'workstation_agent', configuration: { agentId: lab.agentId, verificationIntervalMs: 1 } }]), agents: lab.registry });
  lab.start();
  const accepted = await router.execute('pause', 'C:/VMs/web/web.vmx', { connectionId: 'c1' });
  assert.equal(router.active.size, 1);
  assert.equal((await router.verify(accepted.providerReference)).observedFinalState, 'suspended');
  assert.equal(router.active.size, 0);
  const viaMock = await router.execute('start', 'vm-1', {});
  assert.ok(viaMock.providerReference);
});

test('nested ESXi hosts running as Workstation VMs get their real host name from the matching ESXi connection, matched by address', () => {
  const identities = [{ managementAddress: '10.0.0.60', hostName: 'esxi60.lab.example', source: 'esxi_management_api' }, { managementAddress: 'ESXI-B.lab', hostName: 'esxi-b.lab.example' }];
  const observations = [
    { nativeId: 'a', attributes: { privateIps: ['192.168.1.5', '10.0.0.60'] }, providerMetadata: {} },
    { nativeId: 'b', attributes: { privateIps: ['10.0.0.99'] }, providerMetadata: {} },
    { nativeId: 'c', attributes: { privateIps: ['10.0.0.60'] }, providerMetadata: { hostName: 'already-known' } },
    { nativeId: 'd', attributes: {} },
  ];
  const [a, b, c, d] = correlateNestedEsxiHostnames(observations, identities);
  assert.deepEqual([a.providerMetadata.hostName, a.providerMetadata.hostNameSource], ['esxi60.lab.example', 'esxi_management_api']);
  assert.equal(b.providerMetadata.hostName, undefined);
  assert.equal(c.providerMetadata.hostName, 'already-known', 'a name the agent reported is never overwritten');
  assert.deepEqual(d, observations[3]);
  assert.equal(observations[0].providerMetadata.hostName, undefined, 'the input is not modified');
  assert.deepEqual(correlateNestedEsxiHostnames(observations, [{ managementAddress: null, hostName: 'x' }, { managementAddress: '10.0.0.60' }]).map(o => o.providerMetadata?.hostName), [undefined, undefined, 'already-known', undefined]);
});

test('Workstation discovery adds the real host name of a nested ESXi VM, and still works when that ESXi connection cannot be reached', async () => {
  const lab = workstationLab({ vms: [sampleWorkstationVm('C:/VMs/esx/esx.vmx', { privateIps: ['10.0.0.60'], hostName: undefined }), sampleWorkstationVm('C:/VMs/web/web.vmx', { privateIps: ['192.168.1.20'] })] });
  const workstation = { id: 'ws', status: 'enabled', providerType: 'vmware_workstation', connectionType: 'workstation_agent', configuration: { agentId: lab.agentId } };
  const esxi = (id, address) => ({ id, status: 'enabled', providerType: 'vmware_vsphere', connectionType: 'esxi', endpointUri: `https://${address}/` });
  const asked = [];
  class Router extends ProviderRouter {
    behaviour = () => ({ hostName: 'esxi60.lab.example', managementAddress: '10.0.0.60', source: 'esxi_management_api' });
    async forConnection(connection) { return connection.id.startsWith('esxi') ? { hostIdentity: async () => { asked.push(connection.id); return this.behaviour(); } } : super.forConnection(connection); }
  }
  const router = new Router({ connections: connections([workstation, esxi('esxi-60', '10.0.0.60'), esxi('esxi-unrelated', '10.9.9.9'), { ...esxi('esxi-disabled', '10.0.0.60'), status: 'disabled' }]), agents: lab.registry });
  const found = Object.fromEntries((await router.discover(workstation)).map(o => [o.nativeId, o]));
  assert.deepEqual([found['C:/VMs/esx/esx.vmx'].providerMetadata.hostName, found['C:/VMs/esx/esx.vmx'].providerMetadata.hostNameSource], ['esxi60.lab.example', 'esxi_management_api']);
  assert.equal(found['C:/VMs/web/web.vmx'].providerMetadata.hostName, 'web.lab.example');
  assert.deepEqual(asked, ['esxi-60'], 'only an enabled ESXi connection whose address matches a VM is asked');
  const down = new Router({ connections: connections([workstation, esxi('esxi-60', '10.0.0.60')]), agents: lab.registry });
  down.behaviour = () => { throw new Error('ESXi is down'); };
  const survived = await down.discover(workstation);
  assert.equal(survived.length, 2);
  assert.equal(survived.find(o => o.nativeId === 'C:/VMs/esx/esx.vmx').providerMetadata.hostName, null);
});
