// Threshold alerts in the console (docs/alerts.md): the notification bell, the open and resolved alerts, the rule table, and the dialog that creates and changes a rule. Pure functions,
// kept apart from app.js so they can be tested in node; app.js passes in `esc`, `when` and `badge` and puts the HTML in the page. The server decides what a rule may be and when an
// alert fires; what is checked here only saves a round trip.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SEVERITY_LABEL = { critical: 'Critical', warning: 'Warning' };
const KIND_LABEL = { vm: 'Virtual machines', host: 'Hosts', datastore: 'Datastores', cluster: 'Clusters' };
const trim = value => String(Math.round(Number(value) * 100) / 100);

export const formatValue = (metrics, key, value) => {
  const unit = metrics.find(metric => metric.key === key)?.unit ?? '';
  return `${trim(value)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
};
export const ruleSummary = (metrics, rule) => {
  const metric = metrics.find(item => item.key === rule.metric);
  return `${metric?.label ?? rule.metric} ${rule.comparison} ${formatValue(metrics, rule.metric, rule.threshold)}${rule.durationMinutes ? ` for ${plural(rule.durationMinutes, 'minute')}` : ''}`;
};

// ---- the bell -----------------------------------------------------------------------------------------------------------------------------------------------------------------
export const bellLabel = unread => (unread > 0 ? `Notifications, ${plural(unread, 'new one')}` : 'Notifications, none new');
export const countText = unread => (unread > 99 ? '99+' : String(unread));

export function notificationsHtml(feed, { esc, when, badge }) {
  const since = feed.lastReadAt ?? null;
  const items = feed.items.length
    ? `<ul class="notify-list">${feed.items.map(event => {
      const fresh = since ? event.at > since : true;
      return `<li class="notify-item${fresh ? ' is-new' : ''}"><span class="notify-mark" aria-hidden="true"></span><div><p class="notify-title">${badge(event.severity)} <strong>${esc(event.title)}</strong>${fresh ? '<span class="sr-only"> (new)</span>' : ''}</p><p class="notify-detail">${event.kind === 'resolved' ? 'Resolved · ' : ''}${esc(event.detail)}</p><small>${esc(when(event.at))}${event.source === 'connection' ? ' · connection' : ''}</small></div></li>`;
    }).join('')}</ul>`
    : '<div class="empty compact"><strong>Nothing to report</strong><p>Alerts appear here when a rule fires or a connection has trouble.</p></div>';
  return `<div class="notify-head"><strong>Notifications</strong><button type="button" class="text-button" data-notifications-read${feed.unreadCount ? '' : ' disabled'}>Mark all as read</button></div>${items}<div class="notify-foot"><button type="button" class="text-button" data-go="alert-rules">Alert rules and open alerts →</button></div>`;
}

// ---- the alerts ---------------------------------------------------------------------------------------------------------------------------------------------------------------
export function openAlertsHtml(alerts, metrics, { esc, when, badge, canAcknowledge }) {
  if (!alerts.length) return '<tr><td colspan="6"><div class="empty compact"><strong>No open alerts</strong><p>Everything the rules watch is within its limits.</p></div></td></tr>';
  return alerts.map(alert => {
    const action = alert.status === 'acknowledged'
      ? `<span class="alert-acked">Acknowledged${alert.acknowledgedAt ? ` · ${esc(when(alert.acknowledgedAt))}` : ''}</span>`
      : canAcknowledge ? `<button type="button" data-alert-acknowledge="${esc(alert.id)}">Acknowledge<span class="sr-only"> alert for ${esc(alert.targetName)}</span></button>` : '';
    return `<tr data-alert-row="${esc(alert.id)}"><td>${badge(alert.severity)}</td><td><strong>${esc(alert.targetName)}</strong><small class="block">${esc(alert.ruleName)}</small></td><td>${esc(formatValue(metrics, alert.metric, alert.value))}<small class="block">limit ${esc(alert.comparison)} ${esc(formatValue(metrics, alert.metric, alert.threshold))}</small></td><td>${esc(when(alert.firstSeenAt))}</td><td>${badge(alert.status)}</td><td class="row-actions right">${action}</td></tr>`;
  }).join('');
}

const REASONS = { cleared: 'Back within the limit', rule_disabled: 'Rule turned off', rule_deleted: 'Rule deleted', scope_changed: 'Rule no longer covers it', target_gone: 'No longer reported' };
export function resolvedAlertsHtml(alerts, metrics, { esc, when }) {
  if (!alerts.length) return '<tr><td colspan="4"><div class="empty compact"><p>Nothing has resolved yet.</p></div></td></tr>';
  return alerts.map(alert => `<tr><td><strong>${esc(alert.targetName)}</strong><small class="block">${esc(alert.ruleName)}</small></td><td>${esc(formatValue(metrics, alert.metric, alert.value))}</td><td>${esc(when(alert.firstSeenAt))} → ${esc(when(alert.resolvedAt))}</td><td>${esc(REASONS[alert.resolvedReason] ?? 'Resolved')}</td></tr>`).join('');
}

// ---- the rules ----------------------------------------------------------------------------------------------------------------------------------------------------------------
export function rulesHtml(rules, metrics, { esc, badge, canManage, connectionName }) {
  if (!rules.length) return `<tr><td colspan="5"><div class="empty compact"><strong>No alert rules yet</strong><p>${canManage ? 'Choose “New rule” to be told when a datastore fills up or a machine runs hot.' : 'An administrator can add rules to be told when a datastore fills up or a machine runs hot.'}</p></div></td></tr>`;
  return rules.map(rule => {
    const open = rule.openAlertCount ? `<span class="badge bad">${rule.openAlertCount} open</span>` : '<span class="badge neutral">none</span>';
    const actions = canManage
      ? `<button type="button" data-alert-rule-toggle="${esc(rule.id)}">${rule.enabled ? 'Turn off' : 'Turn on'}<span class="sr-only"> rule ${esc(rule.name)}</span></button><button type="button" data-alert-rule-edit="${esc(rule.id)}">Edit<span class="sr-only"> rule ${esc(rule.name)}</span></button><button type="button" data-alert-rule-delete="${esc(rule.id)}">Delete<span class="sr-only"> rule ${esc(rule.name)}</span></button>`
      : '';
    return `<tr data-alert-rule-row="${esc(rule.id)}"><td><strong>${esc(rule.name)}</strong><small class="block">${esc(rule.summary ?? ruleSummary(metrics, rule))}</small>${rule.description ? `<small class="block">${esc(rule.description)}</small>` : ''}</td><td>${badge(rule.severity)}</td><td>${esc(rule.connectionId ? connectionName(rule.connectionId) : 'All connections')}</td><td>${rule.enabled ? open : '<span class="badge neutral">turned off</span>'}</td><td class="row-actions right">${actions}</td></tr>`;
  }).join('');
}

// rule: null for a new one. connections: [{ id, name }]. preview: the answer of the preview call, or null.
export function ruleDialogHtml({ rule = null, metrics, connections, error = '', preview = null }, { esc }) {
  const current = rule ?? { name: '', description: '', metric: metrics[0]?.key ?? 'vm.cpu_percent', comparison: 'above', threshold: 90, durationMinutes: 5, severity: 'warning', connectionId: null, enabled: true };
  const groups = [...new Set(metrics.map(metric => metric.kind))];
  const metricOptions = groups.map(kind => `<optgroup label="${esc(KIND_LABEL[kind] ?? kind)}">${metrics.filter(metric => metric.kind === kind).map(metric => `<option value="${esc(metric.key)}"${metric.key === current.metric ? ' selected' : ''}>${esc(metric.label)}${metric.unit ? ` (${esc(metric.unit)})` : ''}</option>`).join('')}</optgroup>`).join('');
  const unit = metrics.find(metric => metric.key === current.metric)?.unit ?? '';
  return `<header><div><p class="eyebrow">ALERT RULE</p><h2 id="alert-rule-title">${esc(rule ? rule.name : 'New alert rule')}</h2></div><button id="alert-rule-close" type="button">Close</button></header>
<p class="tag-help">An alert is raised when the measurement is ${current.comparison === 'below' ? 'below' : 'above'} the limit for the whole duration, and clears by itself when it is not. Measurements older than ten minutes are not believed either way.</p>
<section class="tag-fields"><label>Name<input id="alert-rule-name" name="name" maxlength="100" autocomplete="off" required value="${esc(current.name)}" placeholder="Datastores nearly full"></label><label>Severity<select id="alert-rule-severity" name="severity"><option value="warning"${current.severity === 'warning' ? ' selected' : ''}>Warning</option><option value="critical"${current.severity === 'critical' ? ' selected' : ''}>Critical</option></select></label></section>
<label class="alert-wide">What to measure<select id="alert-rule-metric" name="metric">${metricOptions}</select></label>
<section class="tag-fields"><label>Alert when it is<select id="alert-rule-comparison" name="comparison"><option value="above"${current.comparison === 'above' ? ' selected' : ''}>above</option><option value="below"${current.comparison === 'below' ? ' selected' : ''}>below</option></select></label><label>Limit<span class="account-password-row"><input id="alert-rule-threshold" name="threshold" type="number" step="any" min="0" required value="${esc(current.threshold)}"><span id="alert-rule-unit" class="alert-unit">${esc(unit)}</span></span></label></section>
<section class="tag-fields"><label>For at least (minutes)<input id="alert-rule-duration" name="durationMinutes" type="number" step="1" min="0" max="1440" required value="${esc(current.durationMinutes)}"></label><label>Applies to<select id="alert-rule-connection" name="connectionId"><option value="">All connections</option>${connections.map(connection => `<option value="${esc(connection.id)}"${connection.id === current.connectionId ? ' selected' : ''}>${esc(connection.name)}</option>`).join('')}</select></label></section>
<label class="alert-wide">Description (optional)<input id="alert-rule-description" name="description" maxlength="300" autocomplete="off" value="${esc(current.description ?? '')}"></label>
<label class="account-check"><input id="alert-rule-enabled" name="enabled" type="checkbox"${current.enabled ? ' checked' : ''}><span>Turn this rule on</span></label>
<div id="alert-rule-preview" class="alert-preview" role="status">${preview ? previewHtml(preview, { esc, metrics }) : ''}</div>
<p id="alert-rule-error" class="tag-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>
<p class="mfa-actions"><button id="alert-rule-check" type="button">Check against current data</button><button id="alert-rule-save" type="submit" class="primary">${rule ? 'Save changes' : 'Create rule'}</button></p>`;
}

export function previewHtml(preview, { esc, metrics }) {
  const found = preview.matches.length;
  const head = `<strong>${found ? `${plural(found, 'match', 'matches')} right now` : 'Nothing matches right now'}</strong> <small>(${plural(preview.evaluated, 'thing')} measured${preview.unmeasured ? `, ${preview.unmeasured} without a recent measurement` : ''})</small>`;
  const first = preview.matches.slice(0, 5);
  const metric = preview.metric ?? null;
  return `<p>${head}</p>${found ? `<ul>${first.map(match => `<li>${esc(match.name)}: ${esc(metric ? formatValue(metrics, metric, match.value) : trim(match.value))}</li>`).join('')}${found > 5 ? `<li>and ${found - 5} more</li>` : ''}</ul>` : ''}`;
}

// The request from the dialog's fields; numbers as numbers, an empty connection as null.
export function ruleRequestBody(values) {
  return {
    name: String(values.name ?? '').trim(), description: String(values.description ?? '').trim(), metric: values.metric, comparison: values.comparison,
    threshold: values.threshold === '' || values.threshold === undefined ? NaN : Number(values.threshold), durationMinutes: values.durationMinutes === '' ? 0 : Number(values.durationMinutes),
    severity: values.severity, connectionId: values.connectionId ? values.connectionId : null, enabled: Boolean(values.enabled)
  };
}

// Checks that only save a round trip; null when fine.
export function ruleProblem(body, metrics) {
  const metric = metrics.find(item => item.key === body.metric);
  if (!body.name) return 'Give the rule a name.';
  if (!Number.isFinite(body.threshold)) return 'Enter a limit as a number.';
  if (metric && (body.threshold < 0 || body.threshold > metric.max)) return `The limit must be from 0 to ${metric.max}${metric.unit === '%' ? ' (a percentage)' : ''}.`;
  if (!Number.isInteger(body.durationMinutes) || body.durationMinutes < 0 || body.durationMinutes > 1440) return 'The duration is a whole number of minutes, from 0 to 1440.';
  return null;
}
