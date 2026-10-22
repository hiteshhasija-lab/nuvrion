import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The console's server for the browser tests: the real API and web files, in-process, with in-memory services and the mock provider, plus one mock connection whose
// discovery gives two VMs. Nothing leaves the machine.
export const ADMIN_PASSWORD = 'E2e-Test-Password-1!'; // secret-scan:allow (fake test credential)

export async function startConsole() {
  const workDir = mkdtempSync(join(tmpdir(), 'nuvrion-e2e-'));
  Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_TAGS_FILE: join(workDir, 'tags.json'), NUVRION_INFRASTRUCTURE_FILE: join(workDir, 'infrastructure.json'), NUVRION_ALERTS_FILE: join(workDir, 'alerts.json'), NUVRION_SCHEDULES_FILE: join(workDir, 'schedules.json'), NUVRION_CAPACITY_FILE: join(workDir, 'capacity.json'), NUVRION_WEBHOOKS_FILE: join(workDir, 'webhooks.json'), NUVRION_VIEWS_FILE: join(workDir, 'views.json'), NUVRION_WEBHOOK_ALLOW_HTTP: 'true', NUVRION_WEBHOOK_ALLOW_LOOPBACK: 'true', NUVRION_WEBHOOK_INTERVAL_MS: '200', NUVRION_SCHEDULE_INTERVAL_MS: '3600000', NUVRION_ALERT_INTERVAL_MS: '3600000', NUVRION_UPGRADE_SHARED_DIR: join(workDir, 'upgrades'), NUVRION_BOOTSTRAP_PASSWORD: ADMIN_PASSWORD });
  delete process.env.NUVRION_RUNTIME_PROFILE;
  const log = console.log;                                          // the server logs every request as a JSON line; keep the test output readable
  console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('{"level":'))) log(...args); };
  const { createServer, capacityService } = await import('../../api/src/server.js');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  // Seed through the API, as an administrator, exactly as a person would.
  const login = await fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
  const api = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie, 'x-csrf-token': csrfToken, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const created = await api('POST', '/api/v1/connections', { name: 'E2E lab', providerType: 'vmware_vsphere', connectionType: 'vcenter', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' }, configuration: { adapter: 'mock' } }); // secret-scan:allow (fake test credential)
  await api('POST', `/api/v1/connections/${created.json.id}/discover`);

  // A person who signed up and was approved by the administrator with the given role.
  const createUser = async ({ username, displayName = username, role, password = 'Another-Test-Password-2!' }) => { // secret-scan:allow (fake test credential)
    const signup = await fetch(`${url}/api/v1/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName, password }) });
    const { user } = await signup.json();
    const approved = await fetch(`${url}/api/v1/users/${user.id}`, { method: 'PATCH', headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json', 'if-match': `"${user.rowVersion}"` }, body: JSON.stringify({ status: 'active', roles: [role] }) });
    if (approved.status !== 200) throw new Error(`could not approve ${username}: HTTP ${approved.status}`);
    return { username, password };
  };

  // A pretend Workstation agent: enrolled like the real one, it reports an inventory when asked to (`report`), and Nuvrion reads it with `discover`. Reporting VMs with an
  // old observedAt (or not reporting at all) is what an agent that has stopped answering looks like.
  const addWorkstationAgent = async ({ name = 'TECHY' } = {}) => {
    const { token } = (await api('POST', '/api/v1/agents/enrollment-tokens')).json;
    const enrolled = await (await fetch(`${url}/api/v1/agents/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, name, version: '0.1.46' }) })).json();
    const report = (vms, observedAt = new Date().toISOString()) => fetch(`${url}/api/v1/agents/${enrolled.agentId}/heartbeat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-secret': enrolled.secret }, body: JSON.stringify({ version: '0.1.46', inventory: vms.map(vm => ({ observedAt, ...vm })), diagnostics: null }) });
    const connection = await api('POST', '/api/v1/connections', { name: `${name} Workstation`, providerType: 'vmware_workstation', connectionType: 'workstation_agent', endpointUri: null, credential: { username: 'agent', password: 'agent' }, configuration: { agentId: enrolled.agentId } }); // secret-scan:allow (fake test credential)
    if (connection.status !== 201) throw new Error(`could not create the agent connection: HTTP ${connection.status} ${JSON.stringify(connection.json)}`);
    const discover = () => api('POST', `/api/v1/connections/${connection.json.id}/discover`);
    // The agent picks up the commands waiting for it and reports each as done (as the real one does once VMware has carried it out).
    const completeCommands = async (powerState, { timeoutMs = 8000 } = {}) => {
      const headers = { 'x-agent-secret': enrolled.secret };
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const pending = await (await fetch(`${url}/api/v1/agents/${enrolled.agentId}/commands`, { headers })).json();
        const commands = pending.items ?? pending.commands ?? pending;
        if (Array.isArray(commands) && commands.length) {
          for (const envelope of commands) { const ack = await fetch(`${url}/api/v1/agents/${enrolled.agentId}/commands/${(envelope.payload ?? envelope).commandId}/ack`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed', result: { code: 'NUV_AGENT_OPERATION_VERIFIED', message: 'Done.', powerState } }) }); if (ack.status !== 200) throw new Error(`the command could not be acknowledged: HTTP ${ack.status} ${await ack.text()}`); }
          return commands.length;
        }
        if (Date.now() > deadline) throw new Error('the agent was never asked to do anything');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    return { agentId: enrolled.agentId, secret: enrolled.secret, connectionId: connection.json.id, report, discover, completeCommands };
  };

  // Gives a datastore a past: ten days of readings, one every six hours, that end where the datastore is now and grow by `perDayBytes` a day (nothing in the product writes a
  // history that did not happen, so the lab gives it directly to the capacity store).
  const giveDatastoreHistory = async (name, perDayBytes) => {
    const datastore = (await api('GET', '/api/v1/infrastructure?kind=datastore')).json.items.find(item => item.name === name);
    if (!datastore) throw new Error(`no datastore called ${name}`);
    const { capacityBytes, freeBytes } = datastore.attributes, now = Date.now(), points = [];
    for (let hours = 240; hours >= 6; hours -= 6) points.push({ objectId: datastore.id, connectionId: datastore.connectionId, capacityBytes, freeBytes: freeBytes + perDayBytes * hours / 24, observedAt: now - hours * 3_600_000 });
    return capacityService.record(points);
  };

  // The same for a host or a cluster: ten days of processor or memory readings (one every six hours) that end where it is now and grow by `perDay` (MHz for processor, bytes for memory) a day.
  const giveComputeHistory = async (name, metric, perDay) => {
    const item = (await api('GET', '/api/v1/capacity/compute')).json.items.find(candidate => candidate.name === name);
    if (!item) throw new Error(`no host or cluster called ${name}`);
    const now = Date.now(), points = [];
    for (let hours = 240; hours >= 6; hours -= 6) points.push({ objectId: item.id, metric, connectionId: item.connectionId, capacityBytes: item[metric].capacity, freeBytes: item[metric].free + perDay * hours / 24, observedAt: now - hours * 3_600_000 });
    return capacityService.record(points);
  };

  // A receiver for webhooks on this machine (the lab's server is told it may post to this machine; a real installation never is): it keeps what it was sent and answers as told.
  const receivers = [];
  const startReceiver = async () => {
    const received = [], state = { status: 200 };
    const receiver = http.createServer((req, res) => { let data = ''; req.on('data', chunk => { data += chunk; }); req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: data }); res.writeHead(state.status); res.end(); }); });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    receivers.push(receiver);
    return { url: `http://127.0.0.1:${receiver.address().port}`, received, answerWith: status => { state.status = status; } };
  };

  return {
    url, api, createUser, addWorkstationAgent, giveDatastoreHistory, giveComputeHistory, startReceiver,
    async close() { console.log = log; for (const receiver of receivers) { receiver.closeAllConnections?.(); receiver.close(); } const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections?.(); await closed; rmSync(workDir, { recursive: true, force: true }); }
  };
}
