import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isNewerVersion, formatBytes, plainFailure, deploymentSummary, agentRowHtml, buildRowHtml, newestAvailable } from '../agent-fleet.js';

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const when = iso => `<${iso}>`;
const agent = (over = {}) => ({ id: '4abb459d-9877-45c8-92a6-63a0f8f5045a', name: 'TECHY', version: '0.1.49-lab.1', status: 'online', lastHeartbeatAt: '2026-10-14T14:00:00Z', ...over });

test('versions are compared the way the agent compares them: major.minor.patch, never a downgrade', () => {
  assert.deepEqual(parseVersion('0.1.50-lab.1'), [0, 1, 50]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(isNewerVersion('0.1.50-lab.1', '0.1.49-lab.1'), true);
  assert.equal(isNewerVersion('0.1.49-lab.2', '0.1.49-lab.1'), false, 'only the suffix differs: the agent treats that as the same version');
  assert.equal(isNewerVersion('0.1.9', '0.1.10'), false, 'numeric, not alphabetical');
  assert.equal(isNewerVersion('0.2.0', '0.1.99'), true);
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
  assert.equal(isNewerVersion('0.1.50', 'garbage'), false);
});

test('sizes read naturally', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(42999989), '41.0 MB');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(-1), '—');
});

test('an agent failure code is explained in plain words, and unknown text is shown as it came', () => {
  assert.match(plainFailure('NUV_AGENT_UPGRADE_KEY_NOT_PINNED: No upgrade signing key is pinned'), /no upgrade signing key pinned/i);
  assert.match(plainFailure('NUV_AGENT_UPGRADE_SIGNATURE_INVALID: The upgrade manifest is not signed by the pinned key.'), /not signed by the key pinned/);
  assert.match(plainFailure('NUV_AGENT_UPGRADE_DOWNLOAD_FAILED: unable to verify the first certificate'), /address the agent itself uses/);
  assert.equal(plainFailure('Something the agent said'), 'Something the agent said');
  assert.equal(plainFailure(null), '');
  assert.equal(plainFailure({ reason: 'service did not start' }), 'service did not start');
});

test('each deployment state has a label, a tone and whether it is still going', () => {
  assert.deepEqual(deploymentSummary(null), { label: 'No upgrades yet', tone: 'neutral', active: false, detail: '' });
  for (const [status, active, tone] of [['staged', true, 'warn'], ['downloading', true, 'warn'], ['ready', true, 'warn'], ['installed', false, 'good'], ['failed', false, 'bad'], ['rolled_back', false, 'bad']]) {
    const summary = deploymentSummary({ status, version: '0.1.50-lab.1', rollbackVersion: '0.1.49-lab.1', detail: 'x' });
    assert.equal(summary.active, active, status);
    assert.equal(summary.tone, tone, status);
    assert.match(summary.label, status === 'rolled_back' ? /0\.1\.49-lab\.1/ : /0\.1\.50-lab\.1/);
  }
});

test('an agent row offers Upgrade, or Cancel while an upgrade is under way, and never injects markup', () => {
  const idle = agentRowHtml(agent(), null, { esc, when });
  assert.match(idle, /data-agent-upgrade="4abb459d/);
  assert.doesNotMatch(idle, /data-agent-cancel/);
  const going = agentRowHtml(agent(), { deploymentId: 'dep-1', status: 'downloading', version: '0.1.50-lab.1' }, { esc, when });
  assert.match(going, /data-agent-cancel="4abb459d[^"]*" data-deployment="dep-1"/);
  assert.doesNotMatch(going, /data-agent-upgrade/);
  const done = agentRowHtml(agent(), { deploymentId: 'dep-1', status: 'installed', version: '0.1.50-lab.1', completedAt: '2026-10-14T14:43:57Z' }, { esc, when });
  assert.match(done, /Upgraded 0\.1\.50-lab\.1/);
  assert.match(done, /data-agent-upgrade/);
  assert.match(agentRowHtml(agent({ status: 'revoked' }), null, { esc, when }), /data-agent-upgrade="[^"]*" class="primary" disabled/, 'a revoked agent cannot be upgraded');
  assert.doesNotMatch(agentRowHtml(agent(), null, { esc, when, canManage: false }), /<button/);
  const hostile = agentRowHtml(agent({ name: '<img src=x onerror=alert(1)>', version: '"><script>' }), { deploymentId: 'd', status: 'failed', detail: '<b>boom</b>' }, { esc, when });
  assert.doesNotMatch(hostile, /<img|<script|<b>/);
});

test('a build row shows its version, size and the address agents will download it from', () => {
  const row = buildRowHtml({ manifest: { version: '0.1.50-lab.1', createdAt: '2026-10-14T14:00:00Z', sizeBytes: 42999989, artifactUrl: 'https://nuvrion.lab.sps/api/v1/agent-upgrades/artifacts/' + 'a'.repeat(64) }, artifactAvailable: true }, { esc, when });
  assert.match(row, /0\.1\.50-lab\.1/);
  assert.match(row, /41\.0 MB/);
  assert.match(row, /https:\/\/nuvrion\.lab\.sps</);
  assert.match(row, /On the platform/);
  assert.match(buildRowHtml({ manifest: { version: '0.1.1', artifactUrl: 'https://x.example/a' }, artifactAvailable: false }, { esc, when }), /File missing/);
});

const build = (version, over = {}) => ({ manifest: { releaseId: `r-${version}`, version, createdAt: '2026-10-14T10:00:00Z', artifactUrl: 'https://x.example/a' }, artifactAvailable: true, ...over });

test('the newest build offered is the highest version that is really on the platform', () => {
  assert.equal(newestAvailable([]), null);
  assert.equal(newestAvailable(null), null);
  assert.equal(newestAvailable([build('0.1.50-lab.1'), build('0.1.52-lab.1'), build('0.1.51-lab.1')]).manifest.version, '0.1.52-lab.1');
  assert.equal(newestAvailable([build('0.1.50-lab.1'), build('0.1.53-lab.1', { artifactAvailable: false })]).manifest.version, '0.1.50-lab.1', 'a build whose file is gone is not offered');
  assert.equal(newestAvailable([build('0.1.9-lab.1'), build('0.1.10-lab.1')]).manifest.version, '0.1.10-lab.1', 'numeric, not alphabetical');
  assert.equal(newestAvailable([build('nonsense')]), null);
});

test('an agent behind the newest build is told so; one that is current, busy or revoked is not', () => {
  const newest = build('0.1.51-lab.1');
  const behind = agentRowHtml(agent({ version: '0.1.50-lab.1' }), null, { esc, when, available: newest });
  assert.match(behind, /0\.1\.51-lab\.1 available/);
  assert.doesNotMatch(agentRowHtml(agent({ version: '0.1.51-lab.1' }), null, { esc, when, available: newest }), /available/);
  assert.doesNotMatch(agentRowHtml(agent({ version: '0.1.52-lab.1' }), null, { esc, when, available: newest }), /available/, 'an agent ahead of the build is not told to downgrade');
  assert.doesNotMatch(agentRowHtml(agent({ version: '0.1.50-lab.1' }), { deploymentId: 'd', status: 'downloading', version: '0.1.51-lab.1' }, { esc, when, available: newest }), /available/, 'not while it is upgrading');
  assert.doesNotMatch(agentRowHtml(agent({ version: '0.1.50-lab.1', status: 'revoked' }), null, { esc, when, available: newest }), /available/);
  assert.doesNotMatch(agentRowHtml(agent({ version: '0.1.50-lab.1' }), null, { esc, when, available: null }), /available/);
});
