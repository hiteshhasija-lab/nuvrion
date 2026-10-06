import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapabilities, capabilityFor } from '../src/resource-capabilities.js';

const vm = (providerType, powerState, over = {}) => ({ resourceType: 'virtual_machine', lifecycleState: 'active', providerType, attributes: { powerState }, providerMetadata: {}, ...over });
const enabled = resource => evaluateCapabilities(resource).filter(c => c.enabled).map(c => c.operation).sort();
const offered = resource => evaluateCapabilities(resource).map(c => c.operation).sort();

test('power state decides which operations are enabled on VMware', () => {
  const tools = { toolsStatus: 'running' };
  assert.deepEqual(enabled(vm('vmware_vsphere', 'stopped', { providerMetadata: tools })), ['start']);
  assert.deepEqual(enabled(vm('vmware_vsphere', 'running', { providerMetadata: tools })), ['pause', 'power_off', 'reboot_guest', 'restart', 'stop']);
  assert.deepEqual(enabled(vm('vmware_vsphere', 'suspended', { providerMetadata: tools })), ['power_off', 'start', 'stop']);
  assert.deepEqual(enabled(vm('vmware_vsphere', 'unknown', { providerMetadata: tools })), [], 'nothing is allowed when the state is unknown');
});

test('a disabled operation says why', () => {
  const stop = capabilityFor(vm('vmware_vsphere', 'stopped'), 'stop');
  assert.equal(stop.enabled, false);
  assert.equal(stop.reason, 'Unavailable while power state is stopped.');
  assert.equal(capabilityFor(vm('vmware_vsphere', 'stopped'), 'start').reason, null);
});

test('restarting the guest needs VMware Tools to be running', () => {
  const running = vm('vmware_vsphere', 'running');
  assert.equal(capabilityFor(running, 'reboot_guest').enabled, false);
  assert.match(capabilityFor(running, 'reboot_guest').reason, /VMware Tools/);
  for (const status of ['running', 'current', 'guestToolsRunning', 'toolsOk']) {
    assert.equal(capabilityFor(vm('vmware_vsphere', 'running', { providerMetadata: { toolsStatus: status } }), 'reboot_guest').enabled, true, status);
  }
  assert.equal(capabilityFor(vm('vmware_vsphere', 'running', { providerMetadata: { toolsStatus: 'Not running' } }), 'reboot_guest').enabled, false);
  assert.equal(capabilityFor(vm('vmware_vsphere', 'running', { providerMetadata: { toolsRunningStatus: 'guestToolsRunning' } }), 'reboot_guest').enabled, true, 'vSphere field name');
});

test('AWS and Azure only offer start, stop and restart, with provider-specific meanings', () => {
  assert.deepEqual(offered(vm('aws', 'running')), ['restart', 'start', 'stop']);
  assert.deepEqual(offered(vm('azure', 'running')), ['restart', 'start', 'stop']);
  assert.equal(capabilityFor(vm('aws', 'running'), 'restart').providerSemantics, 'EC2 reboot');
  assert.equal(capabilityFor(vm('azure', 'running'), 'stop').providerSemantics, 'Azure deallocate');
});

test('Workstation operations depend on the agent version', () => {
  const at = agentVersion => offered(vm('vmware_workstation', 'running', { providerMetadata: { agentVersion } }));
  assert.deepEqual(at('0.1.4'), ['restart', 'start', 'stop'], 'too old for pause, force power-off and guest restart');
  assert.deepEqual(at('0.1.5'), ['pause', 'restart', 'start', 'stop'], 'pause arrives in 0.1.5');
  assert.deepEqual(at('0.1.43'), ['pause', 'restart', 'start', 'stop']);
  assert.deepEqual(at('0.1.44'), ['pause', 'power_off', 'restart', 'start', 'stop'], 'force power-off arrives in 0.1.44');
  assert.deepEqual(at('0.1.45'), ['pause', 'power_off', 'reboot_guest', 'restart', 'start', 'stop'], 'guest restart arrives in 0.1.45');
  assert.deepEqual(at('0.1.46-lab.1'), at('0.1.45'), 'pre-release suffixes are ignored');
  assert.deepEqual(at('0.2.0'), at('0.1.45'));
  assert.deepEqual(at('1.0.0'), at('0.1.45'));
});

test('Workstation with an unknown agent version offers pause and power-off but not guest restart', () => {
  assert.deepEqual(offered(vm('vmware_workstation', 'running')), ['pause', 'power_off', 'restart', 'start', 'stop']);
});

test('provider semantics describe what each operation really does', () => {
  const running = vm('vmware_vsphere', 'running', { providerMetadata: { toolsStatus: 'running' } });
  assert.equal(capabilityFor(running, 'stop').providerSemantics, 'VMware guest shutdown');
  assert.equal(capabilityFor(running, 'power_off').providerSemantics, 'VMware force power off');
  assert.equal(capabilityFor(running, 'restart').providerSemantics, 'VMware reset');
  assert.equal(capabilityFor(vm('vmware_workstation', 'running'), 'restart').providerSemantics, 'Workstation hard power cycle');
});

test('resources that are not active virtual machines have no capabilities', () => {
  assert.deepEqual(evaluateCapabilities(vm('vmware_vsphere', 'running', { lifecycleState: 'missing' })), []);
  assert.deepEqual(evaluateCapabilities(vm('vmware_vsphere', 'running', { lifecycleState: 'deleted' })), []);
  assert.deepEqual(evaluateCapabilities(vm('vmware_vsphere', 'running', { resourceType: 'host' })), []);
});

test('an unknown provider gets the generic operations with their own names', () => {
  const ops = evaluateCapabilities(vm('some_new_cloud', 'running'));
  assert.deepEqual(ops.map(o => o.operation).sort(), ['restart', 'start', 'stop']);
  assert.equal(ops.find(o => o.operation === 'stop').providerSemantics, 'stop');
});

test('capabilityFor returns null for an operation that is not offered', () => {
  assert.equal(capabilityFor(vm('aws', 'running'), 'pause'), null);
  assert.equal(capabilityFor(vm('vmware_vsphere', 'running'), 'format_disk'), null);
});
