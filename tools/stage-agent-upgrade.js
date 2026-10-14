// Registers a Workstation agent release with the platform and stages it for one agent.
//
//   NUVRION_USERNAME=admin NUVRION_PASSWORD=... node tools/stage-agent-upgrade.js \
//     --url https://nuvrion.example --agent <agent id> --exe ./nuvrion-workstation-agent.exe --version 0.1.50-lab.1
//
// It does not upload the executable: place it on the platform host first, named by its SHA-256, in the agent-artifacts directory
// (printed below). The agent downloads it from the platform, verifies the signed manifest against the key pinned in its
// bootstrap.json, checks size and SHA-256, runs the new executable's self-check, swaps it in and reports each step.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function sha256AndSize(path) {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length };
}

export async function stageAgentUpgrade({ baseUrl, username, password, agentId, version, sha256, sizeBytes, fetchImpl = fetch, artifactUrl = null }) {
  const base = String(baseUrl).replace(/\/$/, '');
  const login = await fetchImpl(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(`Sign-in failed (HTTP ${login.status}).`);
  const session = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const { csrfToken } = await login.json();
  const send = async (method, path, body) => {
    const response = await fetchImpl(`${base}${path}`, { method, headers: { cookie: session, 'x-csrf-token': csrfToken, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`${method} ${path} failed (HTTP ${response.status}): ${json.code ?? ''} ${json.detail ?? ''}`.trim()), { status: response.status, code: json.code });
    return json;
  };
  const key = await send('GET', '/api/v1/agent-upgrades/signing-key');
  const release = await send('POST', '/api/v1/agent-upgrades/releases', { version, artifactUrl: artifactUrl ?? `${base}/api/v1/agent-upgrades/artifacts/${sha256}`, sha256, sizeBytes });
  const deployment = await send('POST', `/api/v1/agents/${agentId}/upgrades`, { releaseId: release.manifest.releaseId });
  return { signingKey: key, release, deployment };
}

function arguments_(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`Unexpected argument: ${name}`);
    out[name.slice(2)] = argv[index + 1];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = arguments_(process.argv.slice(2));
  const { username = process.env.NUVRION_USERNAME, password = process.env.NUVRION_PASSWORD } = args;
  for (const [name, value] of Object.entries({ url: args.url, agent: args.agent, exe: args.exe, version: args.version, NUVRION_USERNAME: username, NUVRION_PASSWORD: password })) {
    if (!value) throw new Error(`Missing ${name}. Usage: node tools/stage-agent-upgrade.js --url <platform url> --agent <agent id> --exe <file> --version <x.y.z[-suffix]>`);
  }
  const { sha256, sizeBytes } = await sha256AndSize(args.exe);
  console.log(`Executable: ${args.exe}\n  sha256 ${sha256}\n  size   ${sizeBytes} bytes`);
  console.log(`The platform host must hold it as: <upgrades directory>/agent-artifacts/${sha256}`);
  const result = await stageAgentUpgrade({ baseUrl: args.url, username, password, agentId: args.agent, version: args.version, sha256, sizeBytes });
  console.log(`\nSigning key id ${result.signingKey.signingKeyId}. Pin this public key in the agent's bootstrap.json as upgradeTrustedPublicKey:\n${result.signingKey.publicKey}`);
  console.log(`Release ${result.release.manifest.releaseId} (${result.release.manifest.version}) staged for agent ${args.agent}; deployment ${result.deployment.deploymentId}.`);
}
