// A small simulated VMware Workstation Pro REST API (vmrest) for testing the legacy WorkstationProvider without a lab. It checks Basic authentication, serves the VM list,
// details and power state, and changes a VM's power state when asked. Pass `fake.fetch` as the provider's fetchImpl.
export const sampleWorkstationRestVm = (id = 'vm-1', over = {}) => ({
  id, path: `C:\\VMs\\${id}\\${id}.vmx`, power: 'poweredOff',
  details: { id, guestOS: 'windows9-64', processors: 2, memory: 4096, hardware: { disks: [{ id: 'sata0:0', capacityBytes: 40 * 1024 ** 3, backing: `C:\\VMs\\${id}\\${id}.vmdk` }], networkAdapters: [{ id: 'ethernet0', network: 'nat', macAddress: '00:0c:29:aa:bb:cc', connected: true, startConnected: true }] } },
  ...over
});

export function fakeWorkstationRest({ vms = [sampleWorkstationRestVm('vm-1'), sampleWorkstationRestVm('vm-2')], username = 'admin', password = 'correct-password' } = {}) { // secret-scan:allow (fake test credential)
  const state = { vms: new Map(vms.map(vm => [vm.id, structuredClone(vm)])) };
  const calls = [], faults = { unreachable: false, status: new Map() };       // faults.status: 'METHOD /path' -> { status, body }
  const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.vmware.vmw.rest-v1+json' } });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname, authorization: init.headers?.authorization, contentType: init.headers?.['content-type'], body: init.body });
    if (faults.unreachable) throw new TypeError('fetch failed: ECONNREFUSED');
    const injected = faults.status.get(`${method} ${url.pathname}`) ?? faults.status.get(`* ${url.pathname}`);
    if (injected) return typeof injected.body === 'string' ? new Response(injected.body, { status: injected.status }) : json(injected.body ?? {}, injected.status);
    if (init.headers?.authorization !== `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`) return json({ Code: 107, Message: 'Authentication failed' }, 401);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);            // ['api','vms',id,'power']
    if (parts[0] !== 'api' || parts[1] !== 'vms') return json({ Message: 'Not found' }, 404);
    if (parts.length === 2 && method === 'GET') return json([...state.vms.values()].map(vm => ({ id: vm.id, path: vm.path })));
    const vm = state.vms.get(parts[2]);
    if (!vm) return json({ Code: 2, Message: 'The virtual machine was not found.' }, 404);
    if (parts.length === 3 && method === 'GET') return json({ ...structuredClone(vm.details), path: vm.path, ...(vm.name ? { name: vm.name } : {}) });
    if (parts[3] === 'power' && method === 'GET') return json({ power_state: vm.power });
    if (parts[3] === 'power' && method === 'PUT') {
      const wanted = JSON.parse(init.body), next = { on: 'poweredOn', off: 'poweredOff', pause: 'paused' }[wanted];
      if (!next) return json({ Message: `Unknown power state ${wanted}.` }, 400);
      vm.power = next;
      return json({ power_state: next });
    }
    return json({ Message: 'Not found' }, 404);
  };
  return { fetch: fetchImpl, state, calls, faults };
}
