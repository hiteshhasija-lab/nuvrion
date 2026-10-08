import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The console's server for the browser tests: the real API and web files, in-process, with in-memory services and the mock provider, plus one mock connection whose
// discovery gives two VMs. Nothing leaves the machine.
export const ADMIN_PASSWORD = 'E2e-Test-Password-1!'; // secret-scan:allow (fake test credential)

export async function startConsole() {
  const workDir = mkdtempSync(join(tmpdir(), 'nuvrion-e2e-'));
  Object.assign(process.env, { NUVRION_STATE_FILE: join(workDir, 'state.json'), NUVRION_INVENTORY_FILE: join(workDir, 'inventory.json'), NUVRION_UPGRADE_SHARED_DIR: join(workDir, 'upgrades'), NUVRION_BOOTSTRAP_PASSWORD: ADMIN_PASSWORD });
  delete process.env.NUVRION_RUNTIME_PROFILE;
  const log = console.log;                                          // the server logs every request as a JSON line; keep the test output readable
  console.log = (...args) => { if (!(typeof args[0] === 'string' && args[0].startsWith('{"level":'))) log(...args); };
  const { createServer } = await import('../../api/src/server.js');
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

  return {
    url, api, createUser,
    async close() { console.log = log; const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections?.(); await closed; rmSync(workDir, { recursive: true, force: true }); }
  };
}
