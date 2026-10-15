// Workstation agents on the Connections page: which version each agent runs, add an agent build, upgrade an agent from the console,
// follow the upgrade, and cancel one that has not finished. The functions up to startAgentFleet are pure so they can be tested in node;
// only startAgentFleet touches the page.

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// The agent compares major.minor.patch only and never downgrades; the console mirrors that so it does not offer what would be refused.
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

// The newest build that is actually on the platform (a release whose file is missing cannot be offered), by version number.
export function newestAvailable(releases) {
  let best = null;
  for (const release of releases ?? []) {
    const version = release?.manifest?.version;
    if (!release?.artifactAvailable || !parseVersion(version)) continue;
    if (!best || isNewerVersion(version, best.manifest.version)) best = release;
  }
  return best;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const FAILURES = {
  NUV_AGENT_UPGRADE_KEY_NOT_PINNED: 'This agent has no upgrade signing key pinned. Pin the platform signing key in its bootstrap.json (shown under Builds), restart the agent, then try again.',
  NUV_AGENT_UPGRADE_SIGNATURE_INVALID: 'The release is not signed by the key pinned on this agent, or the pinned key could not be read.',
  NUV_AGENT_UPGRADE_DOWNLOAD_FAILED: 'The agent could not download the build. The build address must be the address the agent itself uses for the platform.',
  NUV_AGENT_UPGRADE_NOT_NEWER: 'The build is not newer than the version the agent is running. An agent never downgrades.',
  NUV_AGENT_UPGRADE_CHECKSUM_MISMATCH: 'The downloaded file did not match the checksum in the release.',
  NUV_AGENT_UPGRADE_SIZE_MISMATCH: 'The downloaded file was not the size the release states.',
  NUV_AGENT_UPGRADE_SELF_CHECK_FAILED: 'The new executable did not report the version the release names, so it was not installed.',
  NUV_AGENT_UPGRADE_NOT_APPLIED: 'The upgrade was swapped in but the agent kept running the old version.'
};

export function plainFailure(detail) {
  const text = typeof detail === 'string' ? detail : detail && typeof detail === 'object' ? String(detail.reason ?? detail.message ?? JSON.stringify(detail)) : '';
  if (!text) return '';
  const code = /^(NUV_[A-Z_]+)/.exec(text)?.[1];
  return FAILURES[code] ?? text;
}

// What to show for an agent's latest deployment: a short label, a tone for the badge, whether it is still going, and the explanation.
export function deploymentSummary(deployment) {
  if (!deployment) return { label: 'No upgrades yet', tone: 'neutral', active: false, detail: '' };
  const version = deployment.version ? ` ${deployment.version}` : '';
  switch (deployment.status) {
    case 'staged': return { label: `Waiting for the agent${version}`, tone: 'warn', active: true, detail: 'The agent picks it up within about a minute.' };
    case 'downloading': return { label: `Downloading${version}`, tone: 'warn', active: true, detail: '' };
    case 'ready': return { label: `Installing${version}`, tone: 'warn', active: true, detail: 'The agent restarts itself and reports back.' };
    case 'installed': return { label: `Upgraded${version}`, tone: 'good', active: false, detail: '' };
    case 'rolled_back': return { label: `Rolled back${deployment.rollbackVersion ? ` to ${deployment.rollbackVersion}` : ''}`, tone: 'bad', active: false, detail: plainFailure(deployment.detail) };
    case 'failed': return { label: `Failed${version}`, tone: 'bad', active: false, detail: plainFailure(deployment.detail) };
    default: return { label: String(deployment.status ?? 'Unknown'), tone: 'neutral', active: false, detail: '' };
  }
}

// One line about an agent's automatic-upgrade policy: what it is set to, and, when it is on, why it is not acting if that is because the build
// it would install already failed on this agent.
export function autoUpgradeNote(policy, deployment, available, agent) {
  if (!policy?.autoUpgrade) return '';
  const when = policy.windowStart && policy.windowEnd && policy.windowStart !== policy.windowEnd ? ` only between ${policy.windowStart} and ${policy.windowEnd} (${policy.windowTimezone})` : '';
  const version = available?.manifest?.version;
  if (version && isNewerVersion(version, agent?.version) && deployment?.version === version && ['failed', 'rolled_back'].includes(deployment.status)) {
    return `Automatic upgrades will not try ${version} again: it ${deployment.status === 'rolled_back' ? 'was rolled back' : 'failed or was cancelled'} on this agent. Upgrade it by hand, or add a newer build.`;
  }
  return `Upgrades automatically${when}.`;
}

export function agentRowHtml(agent, deployment, { esc, when, canManage = true, available = null, policy = null }) {
  const summary = deploymentSummary(deployment), online = agent.status === 'online', revoked = agent.status === 'revoked';
  const offered = available?.manifest?.version && !summary.active && !revoked && isNewerVersion(available.manifest.version, agent.version) ? available.manifest.version : null;
  const actions = !canManage ? '' : summary.active
    ? `<button type="button" data-agent-cancel="${esc(agent.id)}" data-deployment="${esc(deployment.deploymentId)}">Cancel upgrade</button>`
    : `<button type="button" data-agent-upgrade="${esc(agent.id)}" class="primary"${revoked ? ' disabled' : ''}>Upgrade…</button>`;
  return `<tr data-agent-row="${esc(agent.id)}"><td><strong>${esc(agent.name)}</strong><small class="block">${esc(agent.id)}</small></td>`
    + `<td><code>${esc(agent.version ?? '—')}</code>${offered ? `<small class="block"><span class="badge good">${esc(offered)} available</span></small>` : ''}</td>`
    + `<td><span class="badge ${online ? 'good' : revoked ? 'bad' : 'warn'}">${esc(agent.status ?? 'unknown')}</span><small class="block">${agent.lastHeartbeatAt ? `Last seen ${when(agent.lastHeartbeatAt)}` : 'Never seen'}</small></td>`
    + `<td><span class="badge ${summary.tone}">${esc(summary.label)}</span>${summary.detail ? `<small class="block">${esc(summary.detail)}</small>` : ''}${deployment?.completedAt ? `<small class="block">${when(deployment.completedAt)}</small>` : ''}${policy?.autoUpgrade ? `<small class="block"><span class="badge neutral">Automatic</span> ${esc(autoUpgradeNote(policy, deployment, available, agent))}</small>` : ''}</td>`
    + `<td class="row-actions right">${actions}${canManage && !revoked ? `<button type="button" data-agent-policy="${esc(agent.id)}">Automatic…</button>` : ''}</td></tr>`;
}

export function buildRowHtml(release, { esc, when }) {
  const manifest = release.manifest ?? {};
  let origin = '—';
  try { origin = new URL(manifest.artifactUrl).origin; } catch { /* leave the dash */ }
  return `<tr><td><code>${esc(manifest.version)}</code></td><td>${when(manifest.createdAt)}</td><td>${esc(formatBytes(manifest.sizeBytes))}</td>`
    + `<td><code title="Agents download this build from this address">${esc(origin)}</code></td>`
    + `<td><span class="badge ${release.artifactAvailable ? 'good' : 'bad'}">${release.artifactAvailable ? 'On the platform' : 'File missing'}</span></td></tr>`;
}

export function startAgentFleet({ root = document, win = window } = {}) {
  const view = root.getElementById('view-connections');
  if (!view || root.getElementById('agent-fleet')) return null;
  // The token the server issued for this session comes with /auth/me (in production it is also the nuvrion_csrf cookie).
  let csrfToken = '';
  const csrf = () => csrfToken || decodeURIComponent(root.cookie.split('; ').find(item => item.startsWith('nuvrion_csrf='))?.split('=').slice(1).join('=') ?? '');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const when = iso => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(); };
  async function api(path, { method = 'GET', headers = {}, body } = {}) {
    const response = await fetch(`/api/v1${path}`, { method, headers: { ...headers, ...(method !== 'GET' ? { 'x-csrf-token': csrf() } : {}) }, body });
    let value = null;
    try { value = await response.json(); } catch { /* an empty body */ }
    if (!response.ok) throw Object.assign(new Error(value?.detail ?? `Request failed (${response.status})`), { status: response.status, code: value?.code });
    return value;
  }

  view.insertAdjacentHTML('beforeend', `<section id="agent-fleet" class="card agent-fleet-card" aria-labelledby="agent-fleet-title" hidden>
    <header class="agent-fleet-head">
      <span class="agent-fleet-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 8V6a5 5 0 0 1 10 0v2M5 8h14v10H5zM9 18v2m6-2v2M9 12h6"/></svg></span>
      <div><p class="eyebrow">WORKSTATION AGENTS</p><h2 id="agent-fleet-title">Agents and upgrades</h2><p>Manage enrolled hosts and deliver verified agent builds from one place.</p></div>
      <button type="button" id="agent-build-toggle" class="primary">Add agent build…</button>
    </header>
    <div class="agent-fleet-summary" aria-label="Workstation agent summary">
      <div><span>Enrolled</span><strong id="agent-count">0</strong></div>
      <div><span>Online</span><strong id="agent-online-count">0</strong></div>
      <div><span>Latest build</span><strong id="agent-current-build">None</strong></div>
    </div>
    <p id="agent-fleet-message" role="status" class="muted"></p>
    <form id="agent-address-form" class="agent-platform-bar">
      <span class="agent-platform-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg></span>
      <label><span>Agent download address</span><input id="agent-address" type="url" placeholder="https://nuvrion.example" autocomplete="off"></label>
      <button type="submit" class="primary" id="agent-address-save">Save</button>
      <p id="agent-address-note" class="muted"></p>
    </form>
    <form id="agent-build-form" class="form-grid" hidden>
      <label>Executable (nuvrion-workstation-agent.exe)<input id="agent-build-file" type="file" accept=".exe" required></label>
      <label>Version it reports (for example 0.1.51-lab.1)<input id="agent-build-version" required pattern="\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.\\-]+)?" autocomplete="off"></label>
      <label class="span-2">Address agents use for this platform<input id="agent-build-base" type="url" required></label>
      <p class="span-2 muted">This must be exactly the address in the agent's own settings (apiUrl). The agent only trusts its own platform address.</p>
      <div class="form-actions span-2"><button type="submit" class="primary" id="agent-build-submit">Upload and register</button><button type="button" id="agent-build-cancel" class="text-button">Cancel</button></div>
    </form>
    <section class="agent-roster" aria-labelledby="agent-roster-title">
      <div class="agent-section-head"><div><h3 id="agent-roster-title">Enrolled agents</h3><span id="agent-roster-count">0 enrolled</span></div></div>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th>Version</th><th>Status</th><th>Latest upgrade</th><th class="right">Action</th></tr></thead><tbody id="agent-table"></tbody></table></div>
      <div id="agent-empty" class="empty" hidden><strong>No agents enrolled</strong><p>Create an enrollment token and run the agent setup on a Workstation host.</p></div>
    </section>
    <div class="agent-fleet-tools">
      <details class="agent-builds-details"><summary><span class="agent-tool-icon" aria-hidden="true">↓</span><span class="agent-tool-copy"><strong>Build library</strong><small id="agent-build-count">No registered builds</small></span><span class="agent-tool-arrow" aria-hidden="true">›</span></summary>
        <div class="table-wrap"><table><thead><tr><th>Version</th><th>Registered</th><th>Size</th><th>Address</th><th>State</th></tr></thead><tbody id="agent-builds"></tbody></table></div>
      </details>
      <details id="agent-key-details"><summary><span class="agent-tool-icon" aria-hidden="true">◇</span><span class="agent-tool-copy"><strong>Agent trust key</strong><small>Required once per agent</small></span><span class="agent-tool-arrow" aria-hidden="true">›</span></summary>
        <div class="agent-key-content"><p class="muted">Add this to the agent's bootstrap.json as <code>upgradeTrustedPublicKey</code> and restart the agent. An agent refuses every upgrade until a key is pinned.</p>
        <pre id="agent-key" tabindex="0"></pre></div></details>
    </div>
  </section>
  <dialog id="agent-upgrade-dialog" aria-labelledby="agent-upgrade-title">
    <form method="dialog" id="agent-upgrade-form" class="form-grid">
      <div class="form-title"><div><p class="eyebrow">UPGRADE AGENT</p><h2 id="agent-upgrade-title">Upgrade</h2></div></div>
      <label class="span-2">Build<select id="agent-upgrade-release" required></select></label>
      <p id="agent-upgrade-note" class="span-2 muted"></p>
      <p id="agent-upgrade-error" role="alert" class="span-2"></p>
      <div class="form-actions span-2"><button type="submit" class="primary" id="agent-upgrade-confirm">Upgrade now</button><button type="button" id="agent-upgrade-close" class="text-button">Cancel</button></div>
    </form>
  </dialog>
  <dialog id="agent-policy-dialog" aria-labelledby="agent-policy-title">
    <form method="dialog" id="agent-policy-form" class="form-grid">
      <div class="form-title"><div><p class="eyebrow">AUTOMATIC UPGRADES</p><h2 id="agent-policy-title">Automatic upgrades</h2></div></div>
      <label class="span-2"><input type="checkbox" id="agent-policy-on"> Upgrade this agent automatically when a newer build is on the platform</label>
      <label class="span-2"><input type="checkbox" id="agent-policy-window"> Only during a daily time window</label>
      <label>From<input type="time" id="agent-policy-start" value="01:00"></label>
      <label>Until<input type="time" id="agent-policy-end" value="05:00"></label>
      <label class="span-2">Time zone<input id="agent-policy-zone" autocomplete="off" placeholder="America/Chicago"></label>
      <p class="span-2 muted">The platform upgrades one agent at a time, only while this agent is online, never a build that already failed or was cancelled on it, and the agent still checks the signature and returns to its previous version by itself if the new one does not come up healthy.</p>
      <p id="agent-policy-error" role="alert" class="span-2"></p>
      <div class="form-actions span-2"><button type="submit" class="primary" id="agent-policy-save">Save</button><button type="button" id="agent-policy-close" class="text-button">Cancel</button></div>
    </form>
  </dialog>`);

  const $ = id => root.getElementById(id);
  const section = $('agent-fleet'), dialog = $('agent-upgrade-dialog');
  const state = { agents: [], releases: [], latest: new Map(), key: null, target: null, busy: false, allowed: null, settings: null, policies: new Map() };
  const drawers = [section.querySelector('.agent-builds-details'), $('agent-key-details')];
  for (const drawer of drawers) drawer.addEventListener('toggle', () => {
    if (drawer.open) for (const other of drawers) if (other !== drawer) other.open = false;
  });
  $('agent-build-base').value = win.location.origin;

  function render() {
    section.hidden = false;
    $('agent-empty').hidden = state.agents.length > 0;
    const available = newestAvailable(state.releases);
    $('agent-count').textContent = String(state.agents.length);
    $('agent-online-count').textContent = String(state.agents.filter(agent => agent.status === 'online').length);
    $('agent-current-build').textContent = available?.manifest?.version ?? 'None';
    $('agent-roster-count').textContent = `${state.agents.length} enrolled`;
    $('agent-build-count').textContent = state.releases.length === 1 ? '1 registered build' : `${state.releases.length} registered builds`;
    $('agent-table').innerHTML = state.agents.map(agent => agentRowHtml(agent, state.latest.get(agent.id), { esc, when, available, policy: state.policies.get(agent.id) ?? null })).join('');
    if (win.document.activeElement !== $('agent-address')) $('agent-address').value = state.settings?.publicBaseUrl ?? '';
    $('agent-address-note').textContent = state.settings?.publicBaseUrl
      ? `Agents download builds from ${state.settings.publicBaseUrl}. New agent versions are registered automatically when a platform release that carries one is applied.`
      : `Not set yet${state.settings?.buildsWaiting ? `: ${state.settings.buildsWaiting} published build(s) are waiting for it` : ''}. Enter the address your agents use for the platform (the apiUrl in an agent's settings).`;
    $('agent-builds').innerHTML = state.releases.length ? state.releases.map(release => buildRowHtml(release, { esc, when })).join('')
      : '<tr><td colspan="5">No builds yet. Add the agent executable to upgrade an agent.</td></tr>';
    $('agent-key').textContent = state.key ?? '';
  }

  async function refresh() {
    try {
      if (state.allowed === null) {
        // Ask once who is signed in: agent management is for platform administrators, so nobody else triggers (or is refused by) these calls.
        const me = await api('/auth/me');
        csrfToken = me.csrfToken ?? '';
        state.allowed = (me.user?.permissions ?? []).includes('platform.manage');
      }
      if (!state.allowed) { section.hidden = true; return; }
      const [agents, releases, settings, policies] = await Promise.all([api('/agents'), api('/agent-upgrades/releases'), api('/agent-upgrades/settings'), api('/agent-upgrades/policies')]);
      state.settings = settings;
      state.policies = new Map((policies.items ?? []).map(item => [item.agentId, item]));
      state.agents = (agents.items ?? []).filter(agent => agent.status !== 'revoked' || state.latest.has(agent.id));
      state.releases = releases.items ?? [];
      const histories = await Promise.all(state.agents.map(agent => api(`/agents/${agent.id}/upgrade-deployments?limit=1`).then(result => [agent.id, result.items?.[0] ?? null], () => [agent.id, null])));
      state.latest = new Map(histories);
      if (state.key === null) state.key = (await api('/agent-upgrades/signing-key').catch(() => ({}))).publicKey ?? '';
      render();
    } catch (error) {
      if (error.status === 401 || error.status === 403) { section.hidden = true; if (state.allowed === null) state.allowed = null; }
      else { section.hidden = false; $('agent-fleet-message').textContent = error.message; }
    }
  }

  const message = text => { $('agent-fleet-message').textContent = text; };
  async function sha256Of(file) {
    const digest = await win.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  $('agent-build-toggle').onclick = () => {
    $('agent-build-form').hidden = !$('agent-build-form').hidden;
    if (!$('agent-build-form').hidden) { $('agent-build-base').value = state.settings?.publicBaseUrl || win.location.origin; $('agent-build-file').focus(); }
  };
  $('agent-address-form').onsubmit = async event => {
    event.preventDefault();
    if (state.busy) return;
    state.busy = true; $('agent-address-save').disabled = true;
    try {
      const saved = await api('/agent-upgrades/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicBaseUrl: $('agent-address').value.trim() }) });
      message(saved.imported ? `Saved. ${saved.imported} published build(s) registered.` : 'Saved.');
      await refresh();
    } catch (error) { message(error.message); }
    finally { state.busy = false; $('agent-address-save').disabled = false; }
  };
  $('agent-build-cancel').onclick = () => { $('agent-build-form').hidden = true; };
  $('agent-build-form').onsubmit = async event => {
    event.preventDefault();
    if (state.busy) return;
    const file = $('agent-build-file').files[0];
    if (!file) return;
    state.busy = true; $('agent-build-submit').disabled = true;
    try {
      message(`Checking ${file.name} (${formatBytes(file.size)})…`);
      const sha256 = await sha256Of(file);
      message('Uploading…');
      const query = new URLSearchParams({ version: $('agent-build-version').value.trim(), sha256, baseUrl: $('agent-build-base').value.trim() });
      const result = await api(`/agent-upgrades/builds?${query}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      message(`Registered ${result.release.manifest.version} (${formatBytes(result.artifact.sizeBytes)}). It is ready to upgrade an agent.`);
      $('agent-build-form').reset(); $('agent-build-base').value = win.location.origin; $('agent-build-form').hidden = true;
      await refresh();
    } catch (error) { message(error.message); }
    finally { state.busy = false; $('agent-build-submit').disabled = false; }
  };

  section.addEventListener('click', async event => {
    const upgrade = event.target.closest('[data-agent-upgrade]'), cancel = event.target.closest('[data-agent-cancel]');
    if (upgrade) {
      const agent = state.agents.find(item => item.id === upgrade.dataset.agentUpgrade);
      if (!agent) return;
      state.target = agent;
      const usable = state.releases.filter(release => release.artifactAvailable && isNewerVersion(release.manifest.version, agent.version));
      $('agent-upgrade-title').textContent = `Upgrade ${agent.name}`;
      $('agent-upgrade-release').innerHTML = usable.map(release => `<option value="${esc(release.manifest.releaseId)}">${esc(release.manifest.version)} — registered ${esc(when(release.manifest.createdAt))}</option>`).join('');
      $('agent-upgrade-confirm').disabled = usable.length === 0;
      $('agent-upgrade-note').textContent = usable.length
        ? `Currently ${agent.version}. The agent restarts itself; virtual machines keep running. If the new version does not report healthy within 3 minutes it returns to ${agent.version}.`
        : `There is no build newer than ${agent.version} on the platform. Add one first.`;
      $('agent-upgrade-error').textContent = '';
      dialog.showModal();
    }
    if (cancel) {
      try { await api(`/agents/${cancel.dataset.agentCancel}/upgrade-deployments/${cancel.dataset.deployment}/cancel`, { method: 'POST' }); message('Upgrade cancelled.'); }
      catch (error) { message(error.message); }
      await refresh();
    }
  });
  const policyDialog = $('agent-policy-dialog');
  const syncWindowFields = () => { for (const id of ['agent-policy-start', 'agent-policy-end', 'agent-policy-zone']) $(id).disabled = !$('agent-policy-window').checked; };
  $('agent-policy-window').onchange = syncWindowFields;
  section.addEventListener('click', event => {
    const button = event.target.closest('[data-agent-policy]');
    if (!button) return;
    const agent = state.agents.find(item => item.id === button.dataset.agentPolicy);
    if (!agent) return;
    state.policyTarget = agent;
    const policy = state.policies.get(agent.id);
    $('agent-policy-title').textContent = `Automatic upgrades for ${agent.name}`;
    $('agent-policy-on').checked = Boolean(policy?.autoUpgrade);
    $('agent-policy-window').checked = Boolean(policy?.windowStart && policy?.windowEnd);
    $('agent-policy-start').value = policy?.windowStart ?? '01:00';
    $('agent-policy-end').value = policy?.windowEnd ?? '05:00';
    $('agent-policy-zone').value = policy?.windowTimezone && policy.windowTimezone !== 'UTC' ? policy.windowTimezone : (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
    $('agent-policy-error').textContent = '';
    syncWindowFields();
    policyDialog.showModal();
  });
  $('agent-policy-close').onclick = () => policyDialog.close();
  $('agent-policy-form').onsubmit = async event => {
    event.preventDefault();
    if (!state.policyTarget || state.busy) return;
    state.busy = true; $('agent-policy-save').disabled = true;
    try {
      const windowed = $('agent-policy-window').checked;
      const body = { autoUpgrade: $('agent-policy-on').checked, windowStart: windowed ? $('agent-policy-start').value : null, windowEnd: windowed ? $('agent-policy-end').value : null, windowTimezone: windowed ? $('agent-policy-zone').value.trim() || 'UTC' : 'UTC' };
      await api(`/agents/${state.policyTarget.id}/upgrade-policy`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      policyDialog.close();
      message(body.autoUpgrade ? `${state.policyTarget.name} will be upgraded automatically.` : `Automatic upgrades are off for ${state.policyTarget.name}.`);
      await refresh();
    } catch (error) { $('agent-policy-error').textContent = error.message; }
    finally { state.busy = false; $('agent-policy-save').disabled = false; }
  };
  $('agent-upgrade-close').onclick = () => dialog.close();
  $('agent-upgrade-form').onsubmit = async event => {
    event.preventDefault();
    if (!state.target || state.busy) return;
    state.busy = true; $('agent-upgrade-confirm').disabled = true;
    try {
      await api(`/agents/${state.target.id}/upgrades`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ releaseId: $('agent-upgrade-release').value }) });
      dialog.close();
      message(`Upgrade staged for ${state.target.name}. The agent picks it up within about a minute; this page follows it.`);
      await refresh();
    } catch (error) { $('agent-upgrade-error').textContent = error.message; }
    finally { state.busy = false; $('agent-upgrade-confirm').disabled = false; }
  };

  // Nothing is requested until the Connections view is actually shown (the page may still be at sign-in); then follow it every few seconds
  // while it stays open.
  const showing = () => view.classList.contains('active');
  const observer = new win.MutationObserver(() => { if (showing()) refresh(); });
  observer.observe(view, { attributes: true, attributeFilter: ['class'] });
  if (showing()) refresh();
  const timer = win.setInterval(() => { if (showing() && !root.hidden && !state.busy && state.allowed) refresh(); }, 5000);
  return { refresh, stop: () => { win.clearInterval(timer); observer.disconnect(); } };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') startAgentFleet();
