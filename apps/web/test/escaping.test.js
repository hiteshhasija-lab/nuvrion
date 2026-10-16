import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentRowHtml, buildRowHtml } from '../agent-fleet.js';

// The console builds HTML from strings. Static analysis (docs/security-analysis.md) cannot prove every interpolation is escaped, so what it cannot see is pinned
// here: an identifier or other server-supplied value placed in an attribute must go through esc(), and the fleet card's row builders must not let a hostile
// agent name, version or id become markup.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('no attribute of the console takes an id, an operation or a device key without esc()', () => {
  const raw = [
    /="\$\{[A-Za-z_][\w.]*\.id\}"/g,                  // data-x="${resource.id}", ="${item.resource.id}"
    /="\$\{resourceId\}"/g,
    /="\$\{CSS\.escape\(/g,                           // CSS.escape leaves a double quote in place: it is not HTML escaping
    /(?:data-operation|data-bulk-operation|data-reporting-field)="\$\{(?!esc\()/g,
    /monitor-pressure-row \$\{(?!esc\()/g
  ];
  for (const pattern of raw) assert.deepEqual([...app.matchAll(pattern)].map(match => match[0]), [], `${pattern} still appears in app.js`);
});

test('the select and checkbox helpers escape the keys, labels and ids they are given', () => {
  assert.match(app, /function settingsSelect\(id,value,items,disabled=false\)\{return `<select \$\{id\?`id="\$\{esc\(id\)\}"`:''\}/);
  assert.ok(app.includes('<option value="${esc(key)}" ${key===value?\'selected\':\'\'}>${esc(label)}</option>'));
  assert.ok(app.includes('<input id="${esc(id)}" type="checkbox"'));
  assert.ok(app.includes('${esc(label)}</label>`}'));
});

const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const HOSTILE = `"><img src=x onerror=alert(1)>`;

test('the fleet card rows turn hostile agent and build values into text', () => {
  const agent = { id: HOSTILE, name: HOSTILE, version: HOSTILE, status: HOSTILE, lastHeartbeatAt: null };
  const html = agentRowHtml(agent, { status: 'failed', version: HOSTILE, rollbackVersion: HOSTILE, deploymentId: HOSTILE, detail: HOSTILE }, { esc, when: value => esc(value), available: { version: HOSTILE }, policy: { autoUpgrade: true, windowStart: HOSTILE, windowEnd: `${HOSTILE}2`, windowTimezone: HOSTILE } });
  const build = buildRowHtml({ artifactAvailable: true, manifest: { version: HOSTILE, createdAt: '2026-10-15T00:00:00Z', sizeBytes: 10, releaseId: HOSTILE } }, { esc, when: value => esc(value) });
  for (const html_ of [html, build]) {
    assert.ok(!html_.includes('<img'), 'no element was created from a value');
    assert.ok(!html_.includes(HOSTILE), 'the value appears only in escaped form');
    assert.ok(html_.includes(esc(HOSTILE)), 'and it does appear (the test reaches the values)');
  }
});
