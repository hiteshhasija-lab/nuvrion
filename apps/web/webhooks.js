// Webhooks in the console (docs/webhooks.md): the table on the Alert rules page, the dialog that adds or changes one, and the history of what was sent. Pure functions, kept apart from
// app.js so they can be tested in node; app.js passes in `esc`, `when` and `badge`. The server decides what a webhook may be; what is checked here only saves a round trip. The address
// and the signing secret are write-only: the console never has them after they are saved, so a change leaves them out unless the person types a new one.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const FORMAT_SHORT = { json: 'JSON', text: 'Text message', discord: 'Discord' };

export const eventsSummary = (webhook, catalogue) => {
  const keys = Object.keys(catalogue);
  return webhook.events.length === keys.length ? 'all events' : webhook.events.map(key => key).join(', ');
};

// ---- the table ----------------------------------------------------------------------------------------------------------------------------------------------------------
function statusCell(webhook, { esc, when, badge }) {
  if (!webhook.enabled) return '<span class="badge neutral">turned off</span>';
  if (webhook.consecutiveFailures > 0) return `<span class="badge bad">failing</span><small class="block">${esc(plural(webhook.consecutiveFailures, 'failed attempt'))} in a row${webhook.lastError ? `: ${esc(webhook.lastError)}` : ''}</small>${webhook.pendingCount ? `<small class="block">${esc(plural(webhook.pendingCount, 'message'))} waiting</small>` : ''}`;
  if (webhook.lastSuccessAt) return `${badge('healthy')}<small class="block">Last sent ${esc(when(webhook.lastSuccessAt))}</small>${webhook.pendingCount ? `<small class="block">${esc(plural(webhook.pendingCount, 'message'))} waiting</small>` : ''}`;
  return '<span class="badge neutral">nothing sent yet</span>';
}

export function webhooksHtml(webhooks, catalogue, ctx) {
  const { esc } = ctx;
  if (!webhooks.length) return '<tr><td colspan="4"><div class="empty compact"><strong>No webhooks yet</strong><p>Add a webhook to have alerts, connection problems and failed schedule runs posted to a chat channel or your own system.</p></div></td></tr>';
  return webhooks.map(webhook => `<tr data-webhook-row="${esc(webhook.id)}"><td><strong>${esc(webhook.name)}</strong><small class="block">${esc(FORMAT_SHORT[webhook.format] ?? webhook.format)} · ${esc(eventsSummary(webhook, catalogue))} · ${esc(webhook.minSeverity)} and above</small></td><td><span class="webhook-hint">${esc(webhook.urlHint)}</span>${webhook.hasSigningSecret ? '<small class="block">Signed</small>' : ''}</td><td>${statusCell(webhook, ctx)}</td><td class="row-actions right"><button type="button" data-webhook-test="${esc(webhook.id)}">Send test<span class="sr-only"> to webhook ${esc(webhook.name)}</span></button><button type="button" data-webhook-history="${esc(webhook.id)}">History<span class="sr-only"> of webhook ${esc(webhook.name)}</span></button><button type="button" data-webhook-toggle="${esc(webhook.id)}">${webhook.enabled ? 'Turn off' : 'Turn on'}<span class="sr-only"> webhook ${esc(webhook.name)}</span></button><button type="button" data-webhook-edit="${esc(webhook.id)}">Edit<span class="sr-only"> webhook ${esc(webhook.name)}</span></button><button type="button" data-webhook-delete="${esc(webhook.id)}">Delete<span class="sr-only"> webhook ${esc(webhook.name)}</span></button></td></tr>`).join('');
}

// ---- the dialog ---------------------------------------------------------------------------------------------------------------------------------------------------------
// webhook: null for a new one. catalogue: { events: { key: description }, formats: { key: description } }.
export function webhookDialogHtml({ webhook = null, catalogue, error = '' }, { esc }) {
  const current = webhook ?? { name: '', format: 'text', events: Object.keys(catalogue.events), minSeverity: 'warning', enabled: true, urlHint: '', hasSigningSecret: false };
  const chosen = new Set(current.events);
  const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  return `<header><div><p class="eyebrow">WEBHOOK</p><h2 id="webhook-title">${esc(webhook ? webhook.name : 'New webhook')}</h2></div><button id="webhook-close" type="button">Close</button></header>
<p class="tag-help">Nuvrion posts a small message to this address when something below happens. The address is kept encrypted and cannot be read back, so anyone who can see this page cannot learn it. Only addresses starting with https:// are accepted, and not this machine or link-local addresses.</p>
<section class="tag-fields"><label>Name<input id="webhook-name" name="name" maxlength="100" autocomplete="off" required value="${esc(current.name)}" placeholder="Operations channel"></label><label>Message format<select id="webhook-format" name="format">${Object.entries(catalogue.formats).map(([key, label]) => option(key, label, key === current.format)).join('')}</select></label></section>
<label class="alert-wide">Address${webhook ? ` (now ${esc(webhook.urlHint)})` : ''}<input id="webhook-url" name="url" type="url" autocomplete="off" spellcheck="false" ${webhook ? '' : 'required '}value="" placeholder="${webhook ? 'Leave empty to keep the current address' : 'https://hooks.example.com/services/…'}"></label>
<fieldset class="schedule-group"><legend>Send me</legend><div class="webhook-events" role="group" aria-label="Events">${Object.entries(catalogue.events).map(([key, label]) => `<label class="account-check"><input type="checkbox" name="events" value="${esc(key)}"${chosen.has(key) ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>
<label class="alert-wide">Only alerts that are<select id="webhook-severity" name="minSeverity">${option('warning', 'warning or critical', current.minSeverity === 'warning')}${option('critical', 'critical only', current.minSeverity === 'critical')}</select></label></fieldset>
<label class="alert-wide">Signing secret (optional)<input id="webhook-secret" name="signingSecret" type="password" autocomplete="new-password" maxlength="200" placeholder="${webhook && current.hasSigningSecret ? 'A secret is set; type a new one to replace it' : 'Lets the receiver check a message came from Nuvrion'}"></label>
${webhook && current.hasSigningSecret ? '<label class="account-check"><input id="webhook-remove-secret" name="removeSecret" type="checkbox"><span>Remove the signing secret</span></label>' : ''}
<label class="account-check"><input id="webhook-enabled" name="enabled" type="checkbox"${current.enabled ? ' checked' : ''}><span>Turn this webhook on (only what happens afterwards is sent)</span></label>
<p id="webhook-error" class="tag-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>
<p class="mfa-actions"><button id="webhook-save" type="submit" class="primary">${webhook ? 'Save changes' : 'Add webhook'}</button></p>`;
}

// The request from the dialog's fields. Parts that are write-only are sent only when the person typed them: an empty address or secret keeps what is saved.
export function webhookRequestBody(values, { editing = false } = {}) {
  const body = { name: String(values.name ?? '').trim(), format: values.format, events: [...(values.events ?? [])], minSeverity: values.minSeverity, enabled: Boolean(values.enabled) };
  const url = String(values.url ?? '').trim();
  if (url || !editing) body.url = url;
  const secret = String(values.signingSecret ?? '');
  if (secret) body.signingSecret = secret;
  else if (editing && values.removeSecret) body.signingSecret = '';
  return body;
}

// Checks that only save a round trip; null when fine.
export function webhookProblem(body, { editing = false } = {}) {
  if (!body.name) return 'Give the webhook a name.';
  if (!editing && !body.url) return 'Enter the webhook address.';
  if (body.url !== undefined && body.url !== '' && !/^https?:\/\//i.test(body.url)) return 'The address must start with https://.';   // whether plain http is allowed is the installation's rule, which the server applies
  if (!body.events.length) return 'Choose at least one event to send.';
  if (body.signingSecret && (body.signingSecret.length < 8)) return 'The signing secret must have at least 8 characters.';
  return null;
}

// ---- the history --------------------------------------------------------------------------------------------------------------------------------------------------------
const EVENT_LABEL = { 'alert.fired': 'Alert raised', 'alert.resolved': 'Alert resolved', 'connection.down': 'Connection problem', 'connection.recovered': 'Connection recovered', 'schedule.problem': 'Schedule problem', test: 'Test' };
export function deliveriesHtml(deliveries, { esc, when }) {
  if (!deliveries.length) return '<tr><td colspan="4"><div class="empty compact"><p>Nothing has been sent to this webhook yet.</p></div></td></tr>';
  return deliveries.map(delivery => {
    const state = delivery.status === 'sent' ? '<span class="badge good">sent</span>' : delivery.status === 'failed' ? '<span class="badge bad">failed</span>' : `<span class="badge warn">waiting</span>${delivery.attempts ? `<small class="block">next try ${esc(when(delivery.nextAttemptAt))}</small>` : ''}`;
    const result = delivery.status === 'sent' ? `HTTP ${esc(delivery.responseStatus ?? '')}${delivery.durationMs !== null ? ` · ${esc(delivery.durationMs)} ms` : ''}` : delivery.error ? esc(delivery.error) : delivery.attempts ? '' : 'Not tried yet';
    return `<tr><td>${esc(when(delivery.createdAt))}</td><td><strong>${esc(EVENT_LABEL[delivery.eventType] ?? delivery.eventType)}</strong><small class="block">${esc(delivery.title)}</small></td><td>${state}<small class="block">${esc(plural(delivery.attempts, 'attempt'))}</small></td><td>${result}</td></tr>`;
  }).join('');
}

export function historyDialogHtml(webhook, deliveries, ctx) {
  const { esc } = ctx;
  return `<header><div><p class="eyebrow">WEBHOOK HISTORY</p><h2 id="webhook-history-title">${esc(webhook.name)}</h2></div><button id="webhook-history-close" type="button">Close</button></header>
<p class="tag-help">The latest messages, newest first. A message that could not be delivered is tried again after 1, 5, 15 and 60 minutes and 3 hours, and then given up on. History is kept for 30 days.</p>
<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>State</th><th>Result</th></tr></thead><tbody>${deliveriesHtml(deliveries, ctx)}</tbody></table></div>`;
}

// The sentence for the result of a test post.
export function testResultText(delivery) {
  if (delivery.status === 'sent') return `Test message delivered (HTTP ${delivery.responseStatus}${delivery.durationMs !== null ? `, ${delivery.durationMs} ms` : ''}).`;
  return `The test message was not delivered: ${delivery.error ?? 'no answer'}`;
}
