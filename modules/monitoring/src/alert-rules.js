// Threshold alerts (docs/alerts.md): what a rule may look like, how targets are measured, and the plan for one evaluation. Pure functions, shared by both stores (the local file
// and PostgreSQL) so they cannot disagree about when an alert fires or clears.
//
// A rule says "this measurement of this kind of thing, above (or below) this value, for this long, is a warning (or critical)". Each evaluation looks at the latest measurement of
// every target of the rule's kind and plans the changes: an alert fires when the condition has held for the whole duration, is refreshed while it holds, and clears when it no
// longer does. A target whose measurements are older than ten minutes is left alone (neither fired nor cleared on stale data: the connection's own alert says it is unreachable),
// and a measurement that is not reported is not zero.

export const METRICS = Object.freeze({
  'vm.cpu_percent': { kind: 'vm', label: 'Virtual machine CPU use', unit: '%', max: 100 },
  'vm.memory_percent': { kind: 'vm', label: 'Virtual machine memory use', unit: '%', max: 100 },
  'host.cpu_percent': { kind: 'host', label: 'Host CPU use', unit: '%', max: 100 },
  'host.memory_percent': { kind: 'host', label: 'Host memory use', unit: '%', max: 100 },
  'datastore.used_percent': { kind: 'datastore', label: 'Datastore space used', unit: '%', max: 100 },
  'datastore.free_gb': { kind: 'datastore', label: 'Datastore free space', unit: 'GB', max: 10_000_000 }
});
export const METRIC_KEYS = Object.freeze(Object.keys(METRICS));
export const KIND_LABELS = Object.freeze({ vm: 'virtual machine', host: 'host', datastore: 'datastore' });
export const COMPARISONS = Object.freeze(['above', 'below']);
export const SEVERITIES = Object.freeze(['warning', 'critical']);
export const LIMITS = Object.freeze({ rules: 100, nameMax: 100, descriptionMax: 300, durationMax: 1440 });
export const STALE_AFTER_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AlertError extends Error {
  constructor(message, code = 'NUV_ALERT_RULE_INVALID') { super(message); this.code = code; }
}

const plainText = (raw, label, max, { required }) => {
  const text = String(raw ?? '').trim();
  if (!text && required) throw new AlertError(`A rule needs a ${label}.`);
  if (text.length > max) throw new AlertError(`The ${label} may have at most ${max} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) throw new AlertError(`The ${label} may not contain control or invisible formatting characters.`);
  return text;
};

const EDITABLE = ['name', 'description', 'metric', 'comparison', 'threshold', 'durationMinutes', 'severity', 'connectionId', 'enabled'];

// body: the fields of a rule (all of them, with defaults for description, durationMinutes, connectionId and enabled) -> the same, validated. Throws AlertError.
export function parseRule(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AlertError('The request must be a JSON object.');
  const unknown = Object.keys(body).find(key => !EDITABLE.includes(key));
  if (unknown) throw new AlertError(`Unknown field: ${unknown.slice(0, 40)}.`);
  const metric = METRICS[body.metric];
  if (!metric) throw new AlertError(`Unknown metric: ${String(body.metric).slice(0, 60)}.`);
  if (!COMPARISONS.includes(body.comparison)) throw new AlertError('comparison must be "above" or "below".');
  if (!SEVERITIES.includes(body.severity)) throw new AlertError('severity must be "warning" or "critical".');
  if (typeof body.threshold !== 'number' || !Number.isFinite(body.threshold) || body.threshold < 0 || body.threshold > metric.max) throw new AlertError(`The threshold must be a number from 0 to ${metric.max}${metric.unit === '%' ? ' (a percentage)' : ''}.`);
  const durationMinutes = body.durationMinutes ?? 0;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > LIMITS.durationMax) throw new AlertError(`The duration must be a whole number of minutes from 0 to ${LIMITS.durationMax}.`);
  const connectionId = body.connectionId ?? null;
  if (connectionId !== null && (typeof connectionId !== 'string' || !UUID.test(connectionId))) throw new AlertError('connectionId must be a connection identifier, or null for all connections.');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AlertError('enabled must be true or false.');
  return {
    name: plainText(body.name, 'name', LIMITS.nameMax, { required: true }), description: plainText(body.description, 'description', LIMITS.descriptionMax, { required: false }),
    metric: body.metric, comparison: body.comparison, threshold: body.threshold, durationMinutes, severity: body.severity, connectionId: connectionId?.toLowerCase() ?? null, enabled: body.enabled ?? true
  };
}

// A change to an existing rule: only the fields given are replaced, then the whole is validated again.
export function mergeRule(existing, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AlertError('The request must be a JSON object.');
  const unknown = Object.keys(patch).find(key => !EDITABLE.includes(key));
  if (unknown) throw new AlertError(`Unknown field: ${unknown.slice(0, 40)}.`);
  if (!Object.keys(patch).length) throw new AlertError('Nothing to change.');
  return parseRule({ ...Object.fromEntries(EDITABLE.map(key => [key, existing[key]])), ...patch });
}

const trimNumber = value => String(Math.round(value * 100) / 100);
export function describeRule(rule) {
  const metric = METRICS[rule.metric];
  return `${metric?.label ?? rule.metric} ${rule.comparison} ${trimNumber(rule.threshold)}${metric?.unit === '%' ? '%' : ` ${metric?.unit ?? ''}`.trimEnd()}${rule.durationMinutes ? ` for ${rule.durationMinutes} minute${rule.durationMinutes === 1 ? '' : 's'}` : ''}`;
}
export const describeValue = (metric, value) => `${trimNumber(value)}${METRICS[metric]?.unit === '%' ? '%' : ` ${METRICS[metric]?.unit ?? ''}`.trimEnd()}`;

// ---- measuring ---------------------------------------------------------------------------------------------------------------------------------------------------------
// resources: virtual machines; metrics: the latest sample of each; infrastructure: hosts and datastores; connections for their state. Returns the targets to evaluate:
// { kind, id, name, connectionId, observedAt (ms), values: { 'vm.cpu_percent': 12.5, ... } } (a value that is not reported is absent).
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const percent = (used, total) => (number(used) !== null && number(total) !== null && total > 0 ? Math.max(0, used / total * 100) : null);
const timeOf = value => { const at = new Date(value ?? '').getTime(); return Number.isFinite(at) ? at : null; };

export function collectTargets({ resources = [], metrics = [], infrastructure = [], connections = [] }) {
  const live = new Set(connections.filter(connection => connection.status !== 'deleted').map(connection => connection.id));
  const sampleOf = new Map(metrics.map(sample => [sample.resourceId, sample]));
  const targets = [];
  for (const vm of resources) {
    if (vm.resourceType && vm.resourceType !== 'virtual_machine') continue;
    if (vm.lifecycleState !== 'active' || (live.size && !live.has(vm.connectionId))) continue;
    const sample = sampleOf.get(vm.id), observedAt = timeOf(sample?.observedAt);
    if (!sample || observedAt === null) continue;
    const values = {};
    if (number(sample.cpuUtilizationPercent) !== null) values['vm.cpu_percent'] = sample.cpuUtilizationPercent;
    if (number(sample.memoryUtilizationPercent) !== null) values['vm.memory_percent'] = sample.memoryUtilizationPercent;
    targets.push({ kind: 'vm', id: vm.id, name: vm.name, connectionId: vm.connectionId, observedAt, values });
  }
  for (const object of infrastructure) {
    if (object.lifecycleState !== 'active' || (live.size && !live.has(object.connectionId))) continue;
    const observedAt = timeOf(object.observedAt), a = object.attributes ?? {}, values = {};
    if (observedAt === null) continue;
    if (object.kind === 'host') {
      const cpu = percent(a.cpuUsageMhz, a.cpuMhz), memory = percent(a.memoryUsageBytes, a.memoryBytes);
      if (cpu !== null) values['host.cpu_percent'] = Math.min(100, cpu);
      if (memory !== null) values['host.memory_percent'] = Math.min(100, memory);
    } else if (object.kind === 'datastore') {
      const used = number(a.capacityBytes) !== null && number(a.freeBytes) !== null ? a.capacityBytes - a.freeBytes : null, usedPercent = percent(used, a.capacityBytes);
      if (usedPercent !== null) values['datastore.used_percent'] = Math.min(100, usedPercent);
      if (number(a.freeBytes) !== null) values['datastore.free_gb'] = a.freeBytes / 1024 ** 3;
    } else continue;
    targets.push({ kind: object.kind, id: object.id, name: object.name, connectionId: object.connectionId, observedAt, values });
  }
  return targets;
}

// ---- one evaluation ----------------------------------------------------------------------------------------------------------------------------------------------------
const OPEN = ['active', 'acknowledged'];
export const isOpen = alert => OPEN.includes(alert.status);
export const conditionHolds = (rule, value) => (rule.comparison === 'above' ? value > rule.threshold : value < rule.threshold);
const pendingKey = (ruleId, targetId) => `${ruleId}\n${targetId}`;

// rules: all rules; targets: from collectTargets; open: the alerts now active or acknowledged; pending: Map(key -> ms since the condition began to hold); now: ms.
// Returns { fire: [{ rule, target, value }], refresh: [{ alert, rule, target, value }], resolve: [{ alert, reason }], pending: Map, stale: n }.
export function planEvaluation({ rules, targets, open, pending = new Map(), now = Date.now(), staleAfterMs = STALE_AFTER_MS }) {
  const plan = { fire: [], refresh: [], resolve: [], pending: new Map(), stale: 0 };
  const enabled = new Map(rules.filter(rule => rule.enabled).map(rule => [rule.id, rule]));
  const openBy = new Map(open.filter(alert => alert.ruleId).map(alert => [pendingKey(alert.ruleId, alert.targetId), alert]));
  const known = new Set(targets.map(target => target.id)), seen = new Set();
  for (const rule of enabled.values()) {
    const metric = METRICS[rule.metric];
    if (!metric) continue;
    for (const target of targets) {
      if (target.kind !== metric.kind || (rule.connectionId && target.connectionId !== rule.connectionId)) continue;
      const key = pendingKey(rule.id, target.id), value = target.values[rule.metric], alert = openBy.get(key);
      seen.add(key);
      if (value === undefined || value === null) { if (pending.has(key)) plan.pending.set(key, pending.get(key)); continue; }
      if (now - target.observedAt > staleAfterMs) { plan.stale += 1; if (pending.has(key)) plan.pending.set(key, pending.get(key)); continue; }
      if (conditionHolds(rule, value)) {
        const since = pending.get(key) ?? now;
        plan.pending.set(key, since);
        if (now - since >= rule.durationMinutes * 60_000) (alert ? plan.refresh.push({ alert, rule, target, value }) : plan.fire.push({ rule, target, value }));
      } else if (alert) plan.resolve.push({ alert, reason: 'cleared' });
    }
  }
  for (const alert of open) {
    if (!alert.ruleId) continue;
    if (!enabled.has(alert.ruleId)) plan.resolve.push({ alert, reason: rules.some(rule => rule.id === alert.ruleId) ? 'rule_disabled' : 'rule_deleted' });
    else if (!seen.has(pendingKey(alert.ruleId, alert.targetId))) plan.resolve.push({ alert, reason: known.has(alert.targetId) ? 'scope_changed' : 'target_gone' });
  }
  return plan;
}

// What a rule would match right now, without changing anything (for choosing a threshold).
export function previewRule(rule, targets, now = Date.now()) {
  const metric = METRICS[rule.metric];
  const candidates = targets.filter(target => target.kind === metric.kind && (!rule.connectionId || target.connectionId === rule.connectionId));
  const measured = candidates.filter(target => target.values[rule.metric] !== undefined && now - target.observedAt <= STALE_AFTER_MS);
  const matches = measured.filter(target => conditionHolds(rule, target.values[rule.metric])).map(target => ({ id: target.id, name: target.name, value: target.values[rule.metric] }));
  return { evaluated: measured.length, unmeasured: candidates.length - measured.length, matches: matches.sort((a, b) => (rule.comparison === 'above' ? b.value - a.value : a.value - b.value)) };
}

// ---- the notification feed -----------------------------------------------------------------------------------------------------------------------------------------------
// Each alert is up to two events: it fired, and it resolved. Newest first.
export function feedFromAlerts(alerts, limit = 50) {
  const events = [];
  for (const alert of alerts) {
    events.push({ id: `${alert.id}:fired`, kind: 'fired', at: alert.firstSeenAt, source: 'threshold', alertId: alert.id, severity: alert.severity, title: alert.targetName, detail: `${alert.ruleName}: ${describeValue(alert.metric, alert.value)}` });
    if (alert.resolvedAt) events.push({ id: `${alert.id}:resolved`, kind: 'resolved', at: alert.resolvedAt, source: 'threshold', alertId: alert.id, severity: alert.severity, title: alert.targetName, detail: `${alert.ruleName}: back to normal` });
  }
  return events.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}
