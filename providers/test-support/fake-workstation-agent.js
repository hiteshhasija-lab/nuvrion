import { AgentRegistry, verifyAgentCommand } from '../../modules/agents/src/agent-registry.js';
import { AgentCompatibilityPolicy } from '../../modules/agents/src/agent-compatibility.js';

// A simulated Workstation lab: the real in-memory agent registry plus a pretend agent that does what the real one does on a host: sends heartbeats with its
// inventory, collects the signed commands waiting for it, checks the signature, carries them out on its own VMs, and reports a result. Tests use it to drive
// WorkstationAgentProvider without a Windows host.
export const sampleWorkstationVm = (id = 'C:/VMs/web/web.vmx', over = {}) => ({
  id, name: id.split('/').pop().replace(/\.vmx$/, ''), powerState: 'running', healthState: 'healthy', guestOs: 'windows9-64', vcpuCount: 2, memoryBytes: 4 * 1024 ** 3, storageBytes: 40 * 1024 ** 3,
  privateIps: ['192.168.1.20'], path: id, hostName: 'web.lab.example', toolsStatus: 'running', consoleState: 'available', consoleManaged: true, consolePort: 8697,
  hardware: { cdDvdDrives: [{ id: 'sata0:1', connected: false, media: null }] }, mediaImages: ['D:/ISO/server.iso'], mediaLocations: ['D:/ISO'],
  metrics: { cpuUtilizationPercent: 12, memoryUtilizationPercent: 40 }, observedAt: '2026-10-07T01:00:00.000Z', ...over,
});

export function workstationLab({ vms = [sampleWorkstationVm()], version = '0.1.46', minimumVersion = '0.1.0' } = {}) {
  const registry = new AgentRegistry({ compatibility: new AgentCompatibilityPolicy({ minimumVersion, recommendedVersion: '0.1.46' }) });
  const { token } = registry.createEnrollmentToken({ createdBy: 'test' });
  const { agentId, secret } = registry.enroll({ token, name: 'TECHY', version });
  const state = { vms: new Map(vms.map(vm => [vm.id, structuredClone(vm)])), version };
  const behaviour = { silent: false, reject: new Map(), fail: new Map(), confirmationRequired: false, ignoreSignatureCheck: false, handled: [], badSignatures: 0 };
  const beat = () => registry.heartbeat(agentId, secret, { version: state.version, inventory: [...state.vms.values()], diagnostics: { hostname: 'TECHY' } });
  const media = (vm, driveId) => vm?.hardware.cdDvdDrives.find(d => String(d.id) === String(driveId));
  const outcome = (command, request) => {
    const vm = state.vms.get(request.vmxPath ?? command.targetId);
    const { operation } = command;
    if (behaviour.reject.has(operation)) return { status: 'rejected', result: behaviour.reject.get(operation) };
    if (behaviour.fail.has(operation)) return { status: 'failed', result: behaviour.fail.get(operation) };
    if (operation === 'media.browse') return { status: 'completed', result: { code: 'NUV_MEDIA_BROWSED', path: request.path ?? null, entries: [{ name: 'server.iso', type: 'file' }] } };
    if (!vm) return { status: 'failed', result: { code: 'NUV_VM_NOT_FOUND', message: 'No such virtual machine on this host.' } };
    if (operation === 'media.mount' || operation === 'media.eject') {
      if (behaviour.confirmationRequired) return { status: 'failed', result: { code: 'NUV_MEDIA_CONFIRMATION_REQUIRED', message: 'Confirm the media change in VMware Workstation.' } };
      const drive = media(vm, request.driveId);
      if (!drive) return { status: 'failed', result: { code: 'NUV_MEDIA_DRIVE_NOT_FOUND', message: 'The selected CD/DVD drive was not found.' } };
      Object.assign(drive, operation === 'media.mount' ? { media: request.isoPath, connected: true } : { media: null, connected: false });
      return { status: 'completed', result: { code: operation === 'media.mount' ? 'NUV_MEDIA_MOUNTED' : 'NUV_MEDIA_EJECTED', drive: structuredClone(drive), drives: structuredClone(vm.hardware.cdDvdDrives) } };
    }
    const next = { start: 'running', restart: 'running', reboot_guest: 'running', stop: 'stopped', power_off: 'stopped', pause: 'suspended' }[operation];
    if (!next) return { status: 'failed', result: { code: 'NUV_OPERATION_INVALID', message: `Cannot ${operation}.` } };
    vm.powerState = next;
    return { status: 'completed', result: { powerState: next, ...(operation === 'stop' ? { shutdownMode: 'graceful' } : operation === 'power_off' ? { shutdownMode: 'forced' } : {}) } };
  };
  // One round of the agent's work: heartbeat, then answer every waiting command.
  const step = () => {
    beat();
    for (const envelope of registry.pending(agentId, secret)) {
      if (behaviour.silent) continue;
      if (!behaviour.ignoreSignatureCheck && !verifyAgentCommand(secret, envelope)) { behaviour.badSignatures++; continue; }
      const { payload } = envelope;
      let request = {};
      try { request = JSON.parse(payload.targetId); } catch { /* a plain VM path */ }
      const done = outcome(payload, request && typeof request === 'object' ? request : {});
      behaviour.handled.push({ operation: payload.operation, targetId: payload.targetId });
      registry.acknowledge(agentId, secret, payload.commandId, done);
    }
    beat();
  };
  let timer = null;
  beat();
  return { registry, agentId, secret, state, behaviour, beat, step, start() { timer = setInterval(step, 1); timer.unref(); return this; }, stop() { clearInterval(timer); timer = null; } };
}
