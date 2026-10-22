import test from 'node:test';
import assert from 'node:assert/strict';
import { webhooksHtml, webhookDialogHtml, webhookRequestBody, webhookProblem, deliveriesHtml, historyDialogHtml, testResultText, eventsSummary } from '../webhooks.js';

// The webhook table, the dialog and the request it makes, and the history: what each says and offers, that the address and the secret are never put back in the page, that a change keeps
// what was not retyped, and that nothing a server sent is put in the page unescaped.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const when = value => `at ${value}`;
const badge = value => `<span class="badge ${value}">${esc(value)}</span>`;
const ctx = { esc, when, badge };
const catalogue = { events: { 'alert.fired': 'A threshold alert is raised', 'alert.resolved': 'A threshold alert is resolved', 'connection.down': 'A connection has a problem', 'connection.recovered': 'A connection recovered', 'schedule.problem': 'A scheduled run failed' }, formats: { json: 'JSON (every field)', text: 'Text message (Slack, Teams)', discord: 'Discord' } };
const hook = (over = {}) => ({ id: 'w1', name: 'Ops chat', format: 'text', events: Object.keys(catalogue.events), minSeverity: 'warning', enabled: true, activeSince: '2026-10-22T10:00:00Z', urlHint: 'https://hooks.example.com/…', hasSigningSecret: false, consecutiveFailures: 0, lastAttemptAt: null, lastSuccessAt: null, lastError: null, rowVersion: 1, pendingCount: 0, ...over });

test('the table shows where each webhook goes (never the full address), what it sends, and how it is doing', () => {
  const html = webhooksHtml([hook(), hook({ id: 'w2', name: 'Pager', events: ['alert.fired'], minSeverity: 'critical', format: 'json', hasSigningSecret: true, lastSuccessAt: '2026-10-22T11:00:00Z', pendingCount: 2 })], catalogue.events, ctx);
  assert.match(html, /<strong>Ops chat<\/strong><small class="block">Text message · all events · warning and above<\/small>/); assert.match(html, /https:\/\/hooks\.example\.com\/…/);
  assert.match(html, /nothing sent yet/); assert.match(html, /<strong>Pager<\/strong><small class="block">JSON · alert\.fired · critical and above/); assert.match(html, /Signed/);
  assert.match(html, /badge healthy[\s\S]*Last sent at 2026-10-22T11:00:00Z[\s\S]*2 messages waiting/);
  for (const key of ['test', 'history', 'toggle', 'edit', 'delete']) assert.match(html, new RegExp(`data-webhook-${key}="w1"`));
  assert.match(html, /sr-only"> webhook Ops chat</, 'each button says which webhook it is for');
});

test('a failing or turned off webhook says so in words', () => {
  const failing = webhooksHtml([hook({ consecutiveFailures: 3, lastError: 'HTTP 500: unwell', pendingCount: 1 })], catalogue.events, ctx);
  assert.match(failing, /badge bad">failing<\/span><small class="block">3 failed attempts in a row: HTTP 500: unwell<\/small><small class="block">1 message waiting/);
  assert.match(webhooksHtml([hook({ consecutiveFailures: 1 })], catalogue.events, ctx), /1 failed attempt in a row/);
  assert.match(webhooksHtml([hook({ enabled: false, consecutiveFailures: 5 })], catalogue.events, ctx), /turned off/);
  assert.match(webhooksHtml([], catalogue.events, ctx), /No webhooks yet/);
  assert.equal(eventsSummary(hook({ events: ['alert.fired', 'schedule.problem'] }), catalogue.events), 'alert.fired, schedule.problem');
});

test('the dialog for a new webhook asks for everything; one for an existing webhook says where it goes now and asks only for what should change', () => {
  const fresh = webhookDialogHtml({ catalogue }, ctx);
  assert.match(fresh, /New webhook/); assert.match(fresh, /id="webhook-url" name="url" type="url" autocomplete="off" spellcheck="false" required value=""/); assert.match(fresh, /Add webhook/);
  assert.equal((fresh.match(/name="events"/g) ?? []).length, 5); assert.equal((fresh.match(/name="events" value="[^"]+" checked/g) ?? []).length, 5, 'every event is ticked for a new webhook');
  assert.match(fresh, /<option value="text" selected>/); assert.doesNotMatch(fresh, /removeSecret/);
  const edit = webhookDialogHtml({ webhook: hook({ events: ['alert.fired'], hasSigningSecret: true, minSeverity: 'critical' }), catalogue }, ctx);
  assert.match(edit, /<h2 id="webhook-title">Ops chat<\/h2>/); assert.match(edit, /Address \(now https:\/\/hooks\.example\.com\/…\)/); assert.doesNotMatch(edit, /id="webhook-url"[^>]* required/);
  assert.match(edit, /Leave empty to keep the current address/); assert.match(edit, /value="alert\.fired" checked/); assert.doesNotMatch(edit, /value="alert\.resolved" checked/);
  assert.match(edit, /<option value="critical" selected>/); assert.match(edit, /A secret is set; type a new one to replace it/); assert.match(edit, /id="webhook-remove-secret"/); assert.match(edit, /Save changes/);
  assert.match(webhookDialogHtml({ webhook: hook(), catalogue, error: 'Nope' }, ctx), /role="alert">Nope</);
});

test('the request sends the address and the secret only when typed, so a change keeps what is saved; a removed secret is sent empty', () => {
  const values = { name: ' Ops ', url: ' https://hooks.example.com/x ', format: 'text', events: ['alert.fired'], minSeverity: 'critical', signingSecret: 'a-long-secret', enabled: true };   // secret-scan:allow (fake test credential)
  assert.deepEqual(webhookRequestBody(values), { name: 'Ops', url: 'https://hooks.example.com/x', format: 'text', events: ['alert.fired'], minSeverity: 'critical', enabled: true, signingSecret: 'a-long-secret' });   // secret-scan:allow (fake test credential)
  assert.deepEqual(webhookRequestBody({ ...values, url: '', signingSecret: '' }, { editing: true }), { name: 'Ops', format: 'text', events: ['alert.fired'], minSeverity: 'critical', enabled: true });
  assert.deepEqual(webhookRequestBody({ ...values, url: '', signingSecret: '', removeSecret: true }, { editing: true }).signingSecret, '');
  assert.equal('url' in webhookRequestBody({ ...values, url: '' }), true, 'a new webhook always sends the address, so the server can say it is missing');
  assert.equal('signingSecret' in webhookRequestBody({ ...values, signingSecret: '' }), false);
});

test('checks that save a round trip say what is missing', () => {
  const good = webhookRequestBody({ name: 'n', url: 'https://hooks.example.com/x', format: 'json', events: ['alert.fired'], minSeverity: 'warning', enabled: true });
  assert.equal(webhookProblem(good), null);
  for (const [change, pattern] of [[{ name: '' }, /name/], [{ url: '' }, /address/], [{ url: 'ftp://hooks.example.com/x' }, /https/], [{ events: [] }, /event/], [{ signingSecret: 'short' }, /8 characters/]]) assert.match(webhookProblem({ ...good, ...change }), pattern);
  const { url, ...kept } = good;
  assert.equal(webhookProblem(kept, { editing: true }), null, 'an edit may leave the address out');
  assert.match(webhookProblem(kept), /address/);
});

test('the history says what was sent, to what result, and when the next try is', () => {
  const rows = deliveriesHtml([
    { id: 'd1', createdAt: '2026-10-22T10:00:00Z', eventType: 'alert.fired', title: 'datastore2', status: 'sent', attempts: 1, responseStatus: 200, durationMs: 42, error: null, nextAttemptAt: '2026-10-22T10:00:00Z' },
    { id: 'd2', createdAt: '2026-10-22T09:00:00Z', eventType: 'connection.down', title: 'ESXi 7', status: 'pending', attempts: 2, responseStatus: 503, durationMs: 10, error: 'HTTP 503', nextAttemptAt: '2026-10-22T10:30:00Z' },
    { id: 'd3', createdAt: '2026-10-22T08:00:00Z', eventType: 'test', title: 'Test message from Nuvrion', status: 'failed', attempts: 1, responseStatus: 404, durationMs: 5, error: 'HTTP 404', nextAttemptAt: '2026-10-22T08:00:00Z' },
    { id: 'd4', createdAt: '2026-10-22T11:00:00Z', eventType: 'schedule.problem', title: 'Nightly', status: 'pending', attempts: 0, responseStatus: null, durationMs: null, error: null, nextAttemptAt: '2026-10-22T11:00:00Z' }], ctx);
  assert.match(rows, /Alert raised<\/strong><small class="block">datastore2/); assert.match(rows, /badge good">sent[\s\S]*1 attempt<\/small>[\s\S]*HTTP 200 · 42 ms/);
  assert.match(rows, /badge warn">waiting[\s\S]*next try at 2026-10-22T10:30:00Z[\s\S]*2 attempts[\s\S]*HTTP 503/); assert.match(rows, /badge bad">failed[\s\S]*HTTP 404/); assert.match(rows, /Not tried yet/);
  assert.match(deliveriesHtml([], ctx), /Nothing has been sent/);
  const dialog = historyDialogHtml(hook(), [], ctx);
  assert.match(dialog, /<h2 id="webhook-history-title">Ops chat<\/h2>/); assert.match(dialog, /after 1, 5, 15 and 60 minutes and 3 hours/); assert.match(dialog, /id="webhook-history-close"/);
});

test('the result of a test is one sentence', () => {
  assert.equal(testResultText({ status: 'sent', responseStatus: 204, durationMs: 31 }), 'Test message delivered (HTTP 204, 31 ms).');
  assert.equal(testResultText({ status: 'failed', error: 'The receiver refused the connection.' }), 'The test message was not delivered: The receiver refused the connection.');
  assert.match(testResultText({ status: 'failed', error: null }), /no answer/);
});

test('nothing a server sent is put in the page unescaped, and no secret is ever put back', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = webhooksHtml([hook({ name: evil, urlHint: evil, lastError: evil, consecutiveFailures: 1, events: [evil] })], catalogue.events, ctx)
    + webhookDialogHtml({ webhook: hook({ name: evil, urlHint: evil }), catalogue: { events: { [evil]: evil }, formats: { [evil]: evil } }, error: evil }, ctx)
    + deliveriesHtml([{ id: 'x', createdAt: evil, eventType: evil, title: evil, status: 'failed', attempts: 1, responseStatus: 0, durationMs: 0, error: evil, nextAttemptAt: evil }], ctx)
    + historyDialogHtml(hook({ name: evil }), [], ctx);
  assert.doesNotMatch(html, /<img/);
  const dialog = webhookDialogHtml({ webhook: hook({ hasSigningSecret: true }), catalogue }, ctx);
  assert.doesNotMatch(dialog, /value="https:/); assert.match(dialog, /name="signingSecret" type="password"[^>]*>/); assert.doesNotMatch(dialog, /name="signingSecret"[^>]* value=/);
});
