import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkstationAgentProvider, WorkstationAgentProviderError, friendlyGuestOs } from '../src/workstation-agent-provider.js';
import { verifyAgentCommand } from '../../../modules/agents/src/agent-registry.js';
import { defineProviderContract } from '../../test-support/provider-contract.js';
import { workstationLab, sampleWorkstationVm } from '../../test-support/fake-workstation-agent.js';

// The Workstation provider talks to a Windows agent only through the agent registry: it reads the inventory from the agent's heartbeats and sends signed
// commands that the agent picks up and answers. These tests use the real registry with a simulated agent, so they check what the provider asks for, how it reads
// the answers, and what it does when the agent is offline, silent, old or refusing.
const VM = 'C:/VMs/web/web.vmx';
const provider = (lab, over = {}) => new WorkstationAgentProvider({ registry: lab.registry, agentId: lab.agentId, verificationAttempts: 400, verificationIntervalMs: 1, ...over });
const rejectsWith = (work, code, check = () => true) => assert.rejects(work, error => error instanceof WorkstationAgentProviderError && error.code === code && check(error), code);
const running = options => workstationLab(options).start();
const queued = lab => lab.registry.pending(lab.agentId, lab.secret);

defineProviderContract('WorkstationAgentProvider (simulated agent)', () => provider(running({ vms: [sampleWorkstationVm(VM, { powerState: 'stopped' }), sampleWorkstationVm('C:/VMs/db/db.vmx')] })), { strictReferences: true, optional: ['media'] });

test('friendlyGuestOs turns Workstation guest identifiers into readable names and keeps anything it does not know', () => {
  assert.equal(friendlyGuestOs('windows9-64'), 'Microsoft Windows 10 (64-bit)');
  assert.equal(friendlyGuestOs('WINDOWS11-64'), 'Microsoft Windows 11 (64-bit)');
  assert.equal(friendlyGuestOs('rhel8-64'), 'Red Hat Enterprise Linux 8 (64-bit)');
  assert.equal(friendlyGuestOs('rhel7'), 'Red Hat Enterprise Linux 7');
  assert.equal(friendlyGuestOs("familyName='VMware' distroName='vmkernel' kernelVersion='8.0.2'"), 'VMware ESXi 8.0.2');
  assert.equal(friendlyGuestOs('some-new-guest'), 'some-new-guest');
  assert.equal(friendlyGuestOs(null), null);
  assert.equal(friendlyGuestOs('  '), null);
});

test('discovery maps the agent inventory into resources, with the agent as the "zone" and measurements marked as coming from the agent', async () => {
  const lab = workstationLab({ vms: [sampleWorkstationVm(VM), sampleWorkstationVm('C:/VMs/old/old.vmx', { powerState: 'suspended', metrics: null, hostName: undefined, hostname: 'old-host' })] });
  const [web, old] = await provider(lab).discover();
  assert.deepEqual([web.resourceType, web.nativeId, web.name, web.healthState], ['virtual_machine', VM, 'web', 'healthy']);
  assert.deepEqual({ ...web.attributes }, { powerState: 'running', guestOs: 'Microsoft Windows 10 (64-bit)', vcpuCount: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 40 * 1024 ** 3, privateIps: ['192.168.1.20'], publicIps: [], region: 'local-workstation', availabilityZone: lab.agentId, providerShape: null });
  assert.deepEqual([web.metrics.source, web.metrics.cpuUtilizationPercent, web.metrics.observedAt], ['workstation_agent', 12, '2026-10-07T01:00:00.000Z']);
  assert.deepEqual([web.providerMetadata.agentId, web.providerMetadata.agentVersion, web.providerMetadata.hostName, web.providerMetadata.consoleManaged, web.providerMetadata.consolePort, web.providerMetadata.hardware.cdDvdDrives.length], [lab.agentId, '0.1.46', 'web.lab.example', true, 8697, 1]);
  assert.deepEqual([old.attributes.powerState, old.metrics, old.providerMetadata.hostName], ['suspended', null, 'old-host']);
});

test('a VM that reports almost nothing is still discovered, with unknowns rather than invented values', async () => {
  const lab = workstationLab({ vms: [{ id: 'C:/VMs/bare/bare.vmx' }] });
  const [bare] = await provider(lab).discover();
  assert.deepEqual([bare.name, bare.healthState, bare.attributes.powerState, bare.attributes.vcpuCount, bare.attributes.memoryBytes, bare.attributes.guestOs, bare.attributes.privateIps], ['C:/VMs/bare/bare.vmx', 'unknown', 'unknown', null, null, null, []]);
  assert.deepEqual([bare.providerMetadata.consoleState, bare.providerMetadata.consoleManaged, bare.providerMetadata.mediaImages], ['unknown', false, []]);
});

test('testConnection reports the agent, and the capabilities its version supports', async () => {
  const modern = await provider(workstationLab({ version: '0.1.46' })).testConnection();
  assert.deepEqual([modern.status, modern.provider, modern.transport, modern.agentVersion], ['healthy', 'vmware_workstation', 'signed_agent', '0.1.46']);
  for (const capability of ['inventory', 'power.guest_restart', 'power.force_off', 'media.mount', 'media.browse', 'media.live_mount', 'media.desktop_companion']) assert.ok(modern.capabilities.includes(capability), capability);
  const old = await provider(workstationLab({ version: '0.1.12' })).testConnection();
  assert.deepEqual(old.capabilities, ['inventory', 'power.start', 'power.stop', 'power.restart', 'power.pause']);
  const mid = (await provider(workstationLab({ version: '0.1.26' })).testConnection()).capabilities;
  assert.ok(mid.includes('media.assisted_mount') && !mid.includes('media.live_mount') && !mid.includes('power.guest_restart'));
});

test('an agent that is missing, offline, revoked or too old is refused with a clear, correctly retryable error', async () => {
  const lab = workstationLab();
  await rejectsWith(() => new WorkstationAgentProvider({ registry: lab.registry, agentId: 'no-such-agent' }).discover(), 'NUV_AGENT_NOT_FOUND', e => e.status === 404 && e.retryable === false);
  lab.registry.sweep({ offlineAfterMs: 1000, now: Date.now() + 10 * 60_000 });
  for (const call of [p => p.discover(), p => p.testConnection(), p => p.execute('start', 'x')]) await rejectsWith(() => call(provider(lab)), 'NUV_AGENT_OFFLINE', e => e.retryable === true && e.status === 503);
  const revoked = workstationLab(); revoked.registry.revoke(revoked.agentId);
  await rejectsWith(() => provider(revoked).discover(), 'NUV_AGENT_OFFLINE');
  const old = workstationLab({ version: '0.1.5', minimumVersion: '0.1.20' });
  await rejectsWith(() => provider(old).discover(), 'NUV_AGENT_UPGRADE_REQUIRED', e => e.status === 409 && e.retryable === false && /0\.1\.20/.test(e.message));
});

test('features that need a newer agent are refused before any command is queued', async () => {
  const lab = workstationLab({ version: '0.1.12' }), p = provider(lab);
  await rejectsWith(() => p.execute('reboot_guest', VM), 'NUV_AGENT_GUEST_RESTART_UPGRADE_REQUIRED', e => e.status === 409);
  await rejectsWith(() => p.listMedia(VM), 'NUV_AGENT_MEDIA_UPGRADE_REQUIRED');
  await rejectsWith(() => p.mountMedia(VM, { driveId: 'sata0:1', isoPath: 'D:/ISO/server.iso' }), 'NUV_AGENT_MEDIA_UPGRADE_REQUIRED');
  await rejectsWith(() => p.ejectMedia(VM, { driveId: 'sata0:1' }), 'NUV_AGENT_MEDIA_UPGRADE_REQUIRED');
  const media13 = workstationLab({ version: '0.1.13' });
  await rejectsWith(() => provider(media13).browseMedia(), 'NUV_AGENT_MEDIA_BROWSE_UPGRADE_REQUIRED');
  assert.deepEqual([queued(lab).length, queued(media13).length], [0, 0]);
});

test('execute queues one correctly signed command for the VM, and gives a reference that is different every time', async () => {
  const lab = workstationLab(), p = provider(lab);
  const a = await p.execute('restart', VM), b = await p.execute('restart', VM);
  assert.deepEqual([a.operation, a.targetId], ['restart', VM]);
  assert.notEqual(a.providerReference, b.providerReference);
  const pending = queued(lab);
  assert.equal(pending.length, 2);
  for (const envelope of pending) {
    assert.deepEqual([envelope.payload.operation, envelope.payload.targetId, envelope.payload.agentId], ['restart', VM, lab.agentId]);
    assert.ok(verifyAgentCommand(lab.secret, envelope), 'signed with the agent\'s secret');
    assert.ok(!verifyAgentCommand('another-secret', envelope));
  }
  await assert.rejects(() => p.execute('format_disk', VM), e => e.code === 'NUV_OPERATION_INVALID');
});

test('each operation is carried out by the agent and verified with the final state the agent reports', async () => {
  const cases = [['start', 'stopped', 'running', null], ['stop', 'running', 'stopped', 'graceful'], ['power_off', 'running', 'stopped', 'forced'], ['restart', 'running', 'running', null], ['reboot_guest', 'running', 'running', null], ['pause', 'running', 'suspended', null]];
  for (const [operation, from, final, mode] of cases) {
    const lab = running({ vms: [sampleWorkstationVm(VM, { powerState: from })] }), p = provider(lab);
    const result = await p.verify((await p.execute(operation, VM)).providerReference);
    assert.deepEqual([result.observedFinalState, result.shutdownMode], [final, mode], operation);
    assert.equal(result.code, 'NUV_OPERATION_VERIFIED');
    assert.equal(lab.state.vms.get(VM).powerState, final);
    lab.stop();
  }
});

test('when the agent does not state a final state, it is inferred from the operation', async () => {
  const lab = workstationLab(), p = provider(lab);
  for (const [operation, expected] of [['stop', 'stopped'], ['power_off', 'stopped'], ['pause', 'suspended'], ['start', 'running'], ['restart', 'running']]) {
    const { providerReference } = await p.execute(operation, VM);
    const command = queued(lab).at(-1);
    lab.registry.acknowledge(lab.agentId, lab.secret, command.payload.commandId, { status: 'completed', result: {} });
    assert.equal((await p.verify(providerReference)).observedFinalState, expected, operation);
  }
});

test('a command the agent refuses or cannot carry out fails with the agent\'s own code and message, not a timeout', async () => {
  const lab = running(); lab.behaviour.fail.set('start', { code: 'NUV_VMRUN_FAILED', message: 'vmrun exited with code 1.' }); lab.behaviour.reject.set('pause', { code: 'NUV_COMMAND_REJECTED', message: 'Not allowed.' });
  const p = provider(lab);
  const started = await p.execute('start', VM);
  await rejectsWith(() => p.verify(started.providerReference), 'NUV_VMRUN_FAILED', e => e.status === 422 && /exited with code 1/.test(e.message) && e.retryable === false);
  const paused = await p.execute('pause', VM);
  await rejectsWith(() => p.verify(paused.providerReference), 'NUV_COMMAND_REJECTED', e => e.status === 422);
  lab.behaviour.fail.set('stop', {});
  const stopped = await p.execute('stop', VM);
  await rejectsWith(() => p.verify(stopped.providerReference), 'NUV_AGENT_COMMAND_FAILED');
});

test('an agent that never answers ends as a retryable timeout after the allowed number of checks', async () => {
  const lab = running(); lab.behaviour.silent = true;
  const p = provider(lab, { verificationAttempts: 5 }), { providerReference } = await p.execute('start', VM);
  const begun = Date.now();
  await rejectsWith(() => p.verify(providerReference), 'NUV_AGENT_VERIFICATION_TIMEOUT', e => e.retryable === true && e.status === 503);
  assert.ok(Date.now() - begun < 2000);
});

test('a reference is verified once; unknown references are refused', async () => {
  const lab = running(), p = provider(lab);
  await rejectsWith(() => p.verify('workstation-agent:made-up'), 'NUV_AGENT_REFERENCE_INVALID');
  const { providerReference } = await p.execute('pause', VM);
  await p.verify(providerReference);
  await rejectsWith(() => p.verify(providerReference), 'NUV_AGENT_REFERENCE_INVALID');
});

test('a command nobody picks up in time is not left queued: the registry expires it', async () => {
  const lab = workstationLab(), p = provider(lab);
  await p.execute('start', VM);
  assert.equal(queued(lab).length, 1);
  lab.registry.sweep({ offlineAfterMs: 10 ** 9, now: Date.now() + 10 * 60_000 });
  assert.equal(queued(lab).length, 0);
});

test('listing media shows the drives, images and folders from the latest inventory, with warnings that depend on the agent version and the VM state', async () => {
  const lab = workstationLab({ vms: [sampleWorkstationVm(VM), sampleWorkstationVm('C:/VMs/off/off.vmx', { powerState: 'stopped' })] });
  const media = await provider(lab).listMedia(VM);
  assert.deepEqual([media.source, media.requiresPowerOff, media.assistedMedia, media.warnings], ['workstation_agent', false, false, []]);
  assert.deepEqual([media.drives, media.images, media.locations], [[{ id: 'sata0:1', connected: false, media: null }], ['D:/ISO/server.iso'], ['D:/ISO']]);
  await rejectsWith(() => provider(lab).listMedia('C:/VMs/missing/missing.vmx'), 'NUV_MEDIA_VM_NOT_FOUND', e => e.status === 404);
  const assisted = workstationLab({ version: '0.1.26' });
  const assistedMedia = await provider(assisted).listMedia(VM);
  assert.ok(assistedMedia.assistedMedia && /require confirmation/.test(assistedMedia.warnings[0]));
  const legacy = await provider(workstationLab({ version: '0.1.13' })).listMedia(VM);
  assert.ok(legacy.requiresPowerOff && /Power off/.test(legacy.warnings[0]));
});

test('mounting and ejecting media go through the agent, and the inventory shows the result at once', async () => {
  const lab = running(), p = provider(lab);
  const mounted = await p.mountMedia(VM, { driveId: 'sata0:1', isoPath: 'D:/ISO/server.iso' });
  assert.deepEqual([mounted.code, mounted.drive.media, mounted.drive.connected], ['NUV_MEDIA_MOUNTED', 'D:/ISO/server.iso', true]);
  assert.deepEqual(lab.behaviour.handled.at(-1), { operation: 'media.mount', targetId: JSON.stringify({ vmxPath: VM, driveId: 'sata0:1', isoPath: 'D:/ISO/server.iso' }) });
  assert.equal((await p.listMedia(VM)).drives[0].media, 'D:/ISO/server.iso');
  const ejected = await p.ejectMedia(VM, { driveId: 'sata0:1' });
  assert.deepEqual([ejected.code, ejected.drive.media, ejected.drive.connected], ['NUV_MEDIA_EJECTED', null, false]);
  assert.equal((await p.listMedia(VM)).drives[0].media, null);
});

test('invalid media requests are refused before a command is queued', async () => {
  const lab = workstationLab(), p = provider(lab);
  for (const args of [{ driveId: '', isoPath: 'D:/a.iso' }, { driveId: 'sata0:1', isoPath: '' }, { driveId: 5, isoPath: 'D:/a.iso' }, { driveId: 'sata0:1', isoPath: undefined }, { driveId: 'sata0:1', isoPath: 'D:/' + 'x'.repeat(1030) }]) await rejectsWith(() => p.mountMedia(VM, args), 'NUV_MEDIA_REQUEST_INVALID', e => e.status === 422);
  for (const args of [{ driveId: '' }, { driveId: null }, {}]) await rejectsWith(() => p.ejectMedia(VM, args), 'NUV_MEDIA_REQUEST_INVALID');
  for (const path of [5, {}, 'x'.repeat(1025)]) await rejectsWith(() => p.browseMedia(path), 'NUV_MEDIA_BROWSE_PATH_INVALID', e => e.status === 422);
  assert.equal(queued(lab).length, 0);
});

test('a media change the agent cannot make fails with the agent\'s reason; one that needs confirmation in Workstation is reported as such, not as a failure', async () => {
  const lab = running(), p = provider(lab);
  await rejectsWith(() => p.mountMedia(VM, { driveId: 'ide9:9', isoPath: 'D:/ISO/server.iso' }), 'NUV_MEDIA_DRIVE_NOT_FOUND', e => e.status === 422);
  lab.behaviour.confirmationRequired = true;
  const result = await p.mountMedia(VM, { driveId: 'sata0:1', isoPath: 'D:/ISO/server.iso' });
  assert.deepEqual([result.confirmationRequired, result.code], [true, 'NUV_MEDIA_CONFIRMATION_REQUIRED']);
});

test('browsing host drives passes the path to the agent and returns what it found; a silent agent times out with the browse code', async () => {
  const lab = running(), p = provider(lab);
  const root = await p.browseMedia();
  assert.deepEqual([root.code, root.path, root.entries.length], ['NUV_MEDIA_BROWSED', null, 1]);
  assert.deepEqual(lab.behaviour.handled.at(-1), { operation: 'media.browse', targetId: JSON.stringify({ path: null }) });
  assert.equal((await p.browseMedia('D:/ISO')).path, 'D:/ISO');
  lab.behaviour.silent = true;
  await rejectsWith(() => provider(lab, { verificationAttempts: 3 }).browseMedia('D:/'), 'NUV_MEDIA_BROWSE_TIMEOUT', e => e.retryable === true);
});
