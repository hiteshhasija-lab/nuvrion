// A small simulated vCenter for testing the vSphere provider without a lab. It answers the same HTTP calls the provider makes (the vSphere Automation
// REST API under /api, the Web Services SOAP endpoint at /sdk for quick statistics, and the datastore file browser under /folder), keeps virtual
// machines whose power state really changes, and can be told to fail. Nothing here talks to a network: pass `fake.fetch` as the provider's fetchImpl.
import { randomUUID } from 'node:crypto';
import { datastoreFolderResponse } from './fake-datastore.js';

const json = (status, body) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const xml = (status, body, headers = {}) => new Response(`<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`, { status, headers: { 'content-type': 'text/xml', ...headers } });

export function sampleVm(id = 'vm-1', over = {}) {
  return {
    id, name: `VM ${id}`, power: 'POWERED_ON', cpu: 2, memoryMiB: 4096, guestOs: 'UBUNTU_64', host: 'host-10', datacenter: 'datacenter-2', folder: 'group-v3', cluster: 'domain-c8',
    identity: { ip_address: '10.0.0.50', dns_name: `${id}.lab.example` },
    tools: { run_state: 'RUNNING', version_status: 'CURRENT', version: '12352', reboot: { requested: false, timestamp: null } },
    disks: { '2000': { label: 'Hard disk 1', capacity: 40 * 1024 ** 3, type: 'SCSI' }, '2001': { label: 'Hard disk 2', capacity: 10 * 1024 ** 3, type: 'SCSI' } },
    nics: { '4000': { label: 'Network adapter 1', type: 'VMXNET3', mac_address: '00:50:56:aa:bb:cc', state: 'CONNECTED', backing: { network_name: 'VM Network' } } },
    cdroms: { '16000': { label: 'CD/DVD drive 1', backing: { type: 'CLIENT_DEVICE' }, state: 'NOT_CONNECTED', start_connected: false, allow_guest_control: true } },
    quickStats: { cpu: 1500, hostMem: 2048, guestMem: 1024, uptime: 7200, committed: 30 * 1024 ** 3, uncommitted: 20 * 1024 ** 3 },
    ...over
  };
}

export function fakeVcenter({ vms = [sampleVm()], username = 'administrator@vsphere.local', password = 'correct-password', isos = { datastore1: ['images/', 'images/server.iso', 'images/tools/', 'images/tools/drivers.iso', 'readme.txt'] } } = {}) { // secret-scan:allow (fake test credential)
  const state = {
    vms: new Map(vms.map(vm => [vm.id, structuredClone(vm)])),
    tokens: new Set(), sdkSessions: new Set(),
    datastores: Object.keys(isos).map((name, index) => ({ datastore: `datastore-${index + 1}`, name })),
    isos,
    shutdownPolls: 2,            // how many power polls a guest shutdown takes to finish
    rebootPolls: 2,              // and a guest reboot
    guestIgnoresRequests: false, // simulates VMware Tools that accepts the request but never acts on it
    sessionsOpened: 0, sessionsClosed: 0
  };
  const calls = [];
  const faults = { unreachable: false, status: new Map(), sdkFails: false };   // faults.status: 'METHOD path' (without query) -> HTTP status
  const pending = new Map();                                                    // vm id -> { kind, polls }
  const vm = id => state.vms.get(decodeURIComponent(id));

  const advance = target => {                                                   // one power poll passes: let a pending guest action progress
    const wait = pending.get(target.id);
    if (!wait) return;
    wait.polls -= 1;
    if (wait.kind === 'shutdown' && wait.polls <= 0) { target.power = 'POWERED_OFF'; target.tools.run_state = 'NOT_RUNNING'; pending.delete(target.id); }
    if (wait.kind === 'reboot') {
      if (wait.polls > 0) { target.tools.run_state = 'NOT_RUNNING'; target.tools.reboot.requested = true; }
      else { target.tools.run_state = 'RUNNING'; target.tools.reboot.requested = false; target.tools.reboot.timestamp = new Date().toISOString(); pending.delete(target.id); }
    }
  };

  const rest = async (method, url, headers, bodyText) => {
    const path = url.pathname, action = url.searchParams.get('action');
    const authorised = state.tokens.has(headers['vmware-api-session-id']);
    if (path === '/api/session' && method === 'POST') {
      const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      if (headers.authorization !== expected) return json(401, { messages: [{ default_message: 'Unable to authenticate user.' }] });
      const token = randomUUID(); state.tokens.add(token); state.sessionsOpened++;
      return json(201, token);
    }
    if (!authorised) return json(401, { messages: [{ default_message: 'Authentication required.' }] });
    if (path === '/api/session' && method === 'GET') return json(200, { user: username });
    if (path === '/api/session' && method === 'DELETE') { state.tokens.delete(headers['vmware-api-session-id']); state.sessionsClosed++; return json(204); }
    if (path === '/api/vcenter/vm' && method === 'GET') return json(200, [...state.vms.values()].map(v => ({ vm: v.id, name: v.name, power_state: v.power, cpu_count: v.cpu, memory_size_MiB: v.memoryMiB })));
    if (path === '/api/vcenter/datastore') return json(200, state.datastores);
    if (path === '/api/vcenter/datacenter') return json(200, [{ datacenter: 'datacenter-2', name: 'Lab DC' }]);
    const match = path.match(/^\/api\/vcenter\/vm\/([^/]+)(?:\/(.*))?$/);
    if (!match) return json(404, { messages: [{ default_message: 'No such API.' }] });
    const target = vm(match[1]), sub = match[2] ?? '';
    if (!target) return json(404, { messages: [{ default_message: `Virtual machine ${match[1]} not found.` }] });
    if (sub === '' && method === 'GET') return json(200, { name: target.name, power_state: target.power, cpu_count: target.cpu, memory_size_MiB: target.memoryMiB, guest_OS: target.guestOs, host: target.host, disks: target.disks, nics: target.nics, cdroms: target.cdroms });
    if (sub === 'guest/identity') return target.power === 'POWERED_ON' && target.identity ? json(200, target.identity) : json(404, { messages: [{ default_message: 'Guest identity unavailable.' }] });
    if (sub === 'tools') return target.tools ? json(200, { run_state: target.tools.run_state, version_status: target.tools.version_status, version: target.tools.version, guest_reboot_status: { reboot_requested: target.tools.reboot.requested, request_timestamp: target.tools.reboot.timestamp } }) : json(404, {});
    if (sub === 'power' && method === 'GET') { advance(target); return json(200, { state: target.power }); }
    if (sub === 'power' && method === 'POST') {
      const next = { start: 'POWERED_ON', stop: 'POWERED_OFF', reset: 'POWERED_ON', suspend: 'SUSPENDED' }[action];
      if (!next) return json(400, { messages: [{ default_message: 'Unknown action.' }] });
      target.power = next; if (next !== 'POWERED_ON') target.tools.run_state = 'NOT_RUNNING'; else target.tools.run_state = 'RUNNING';
      return json(204);
    }
    if (sub === 'guest/power' && method === 'POST') {
      if (target.power !== 'POWERED_ON') return json(400, { messages: [{ default_message: 'The virtual machine is not powered on.' }] });
      if (!state.guestIgnoresRequests) pending.set(target.id, { kind: action === 'shutdown' ? 'shutdown' : 'reboot', polls: action === 'shutdown' ? state.shutdownPolls : state.rebootPolls });
      return json(204);
    }
    if (sub === 'console/tickets' && method === 'POST') return json(201, target.noTicket ? {} : { ticket: `wss://vcenter.example/ticket/${randomUUID()}` });
    if (sub === 'hardware/cdrom' && method === 'GET') return json(200, Object.keys(target.cdroms).map(id => ({ cdrom: id })));
    const cd = sub.match(/^hardware\/cdrom\/([^/]+)$/);
    if (cd) {
      const drive = target.cdroms[decodeURIComponent(cd[1])];
      if (!drive) return json(404, { messages: [{ default_message: 'CD/DVD drive not found.' }] });
      if (method === 'GET') return json(200, { label: drive.label, backing: drive.backing, state: drive.state, start_connected: drive.start_connected, allow_guest_control: drive.allow_guest_control });
      if (method === 'PATCH') { const body = JSON.parse(bodyText); if (body.backing) drive.backing = body.backing.type === 'ISO_FILE' ? { type: 'ISO_FILE', iso_file: body.backing.iso_file } : { type: body.backing.type }; if ('start_connected' in body) drive.start_connected = body.start_connected; if (target.power === 'POWERED_ON' && drive.backing.type === 'ISO_FILE' && state.autoConnectOnPatch) drive.state = 'CONNECTED'; return json(204); }
      if (method === 'POST' && action === 'connect') { drive.state = 'CONNECTED'; return json(204); }
      if (method === 'POST' && action === 'disconnect') { drive.state = 'NOT_CONNECTED'; return json(204); }
    }
    return json(404, { messages: [{ default_message: `No handler for ${method} ${path}.` }] });
  };

  // The Web Services endpoint the provider uses only for quick statistics (best effort).
  const sdk = async bodyText => {
    if (faults.sdkFails) return xml(500, '<soapenv:Fault><faultstring>The Web Services endpoint is not available.</faultstring></soapenv:Fault>');
    const method = bodyText.match(/<vim25:(\w+)[ >]/)?.[1];
    if (method === 'RetrieveServiceContent') return xml(200, '<RetrieveServiceContentResponse><returnval><sessionManager type="SessionManager">SessionManager</sessionManager><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector></returnval></RetrieveServiceContentResponse>', { 'set-cookie': 'vmware_soap_session="anon"; Path=/' });
    if (method === 'Login') { state.sdkSessions.add('s'); return xml(200, '<LoginResponse><returnval><key>s</key></returnval></LoginResponse>', { 'set-cookie': 'vmware_soap_session="s1"; Path=/' }); }
    if (method === 'Logout') { state.sdkSessions.clear(); return xml(200, '<LogoutResponse/>'); }
    if (method === 'RetrievePropertiesEx') {
      const ids = [...bodyText.matchAll(/<vim25:obj type="VirtualMachine">([^<]+)<\/vim25:obj>/g)].map(m => m[1]);
      const objects = ids.map(id => state.vms.get(id)).filter(v => v?.quickStats).map(v => {
        const q = v.quickStats, prop = (name, value) => value == null ? '' : `<propSet><name>${name}</name><val xsi:type="xsd:int">${value}</val></propSet>`;
        return `<objects><obj type="VirtualMachine">${v.id}</obj>${prop('summary.quickStats.overallCpuUsage', q.cpu)}${prop('summary.quickStats.hostMemoryUsage', q.hostMem)}${prop('summary.quickStats.guestMemoryUsage', q.guestMem)}${prop('summary.quickStats.uptimeSeconds', q.uptime)}${prop('summary.storage.committed', q.committed)}${prop('summary.storage.uncommitted', q.uncommitted)}</objects>`;
      });
      return xml(200, `<RetrievePropertiesExResponse><returnval>${objects.join('')}</returnval></RetrievePropertiesExResponse>`);
    }
    return xml(500, `<soapenv:Fault><faultstring>Unknown method ${method}.</faultstring></soapenv:Fault>`);
  };

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? 'GET', headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const record = { method, path: url.pathname, action: url.searchParams.get('action'), body: init.body ? String(init.body).slice(0, 4000) : undefined };
    calls.push(record);
    if (faults.unreachable) throw new TypeError('fetch failed: ECONNREFUSED');
    const forced = faults.status.get(`${method} ${url.pathname}`) ?? faults.status.get(`* ${url.pathname}`);
    if (forced) return json(forced, { messages: [{ default_message: `Injected failure ${forced}.` }] });
    if (url.pathname === '/sdk') return sdk(String(init.body ?? ''));
    if (url.pathname.startsWith('/folder/')) return datastoreFolderResponse(state.isos, url);
    return rest(method, url, headers, init.body ? String(init.body) : '');
  };

  return { fetch: fetchImpl, state, calls, faults, pending, openSessions: () => state.tokens.size };
}
