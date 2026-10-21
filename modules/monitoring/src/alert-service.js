// Threshold alerts for the local (file-backed) mode: rules, the alerts they raise, and what each person has read. The same interface as PostgresAlertService; what a rule is and
// when an alert fires or clears is decided by alert-rules.js, which both use.
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { AlertError, LIMITS, isOpen, parseRule, mergeRule, planEvaluation, feedFromAlerts } from './alert-rules.js';

const clone = value => structuredClone(value);
const DAY = 24 * 60 * 60_000;
export const UNREAD_WINDOW_MS = DAY;      // a person who has never read their notifications sees the last day's as new

export class AlertService {
  #rules = new Map(); #alerts = []; #reads = new Map(); #pending = new Map(); #file; #clock;
  constructor({ file = null, clock = Date.now } = {}) {
    this.#file = file; this.#clock = clock;
    if (file && existsSync(file)) {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      this.#rules = new Map(state.rules ?? []); this.#alerts = state.alerts ?? []; this.#reads = new Map(state.reads ?? []);
    }
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, rules: [...this.#rules], alerts: this.#alerts, reads: [...this.#reads] }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }
  #iso = ms => new Date(ms).toISOString();
  #publicRule(rule) { return { ...clone(rule), openAlertCount: this.#alerts.filter(alert => alert.ruleId === rule.id && isOpen(alert)).length }; }

  // ---- rules ----
  async listRules() { return [...this.#rules.values()].sort((a, b) => a.name.localeCompare(b.name)).map(rule => this.#publicRule(rule)); }
  async getRule(id) { const rule = this.#rules.get(id); return rule ? this.#publicRule(rule) : null; }
  #checkName(name, exceptId = null) {
    if ([...this.#rules.values()].some(rule => rule.id !== exceptId && rule.name.toLowerCase() === name.toLowerCase())) throw new AlertError(`A rule named "${name}" already exists.`, 'NUV_ALERT_RULE_EXISTS');
  }
  async createRule(input, userId = null) {
    const fields = parseRule(input);
    if (this.#rules.size >= LIMITS.rules) throw new AlertError(`At most ${LIMITS.rules} alert rules may exist.`, 'NUV_ALERT_RULE_LIMIT');
    this.#checkName(fields.name);
    const now = this.#iso(this.#clock()), rule = { id: randomUUID(), ...fields, rowVersion: 1, createdBy: userId, createdAt: now, updatedAt: now };
    this.#rules.set(rule.id, rule); this.#persist();
    return this.#publicRule(rule);
  }
  async updateRule(id, patch, expectedVersion) {
    const rule = this.#rules.get(id);
    if (!rule) return null;
    if (rule.rowVersion !== expectedVersion) throw new Error('VERSION_CONFLICT');
    const fields = mergeRule(rule, patch);
    this.#checkName(fields.name, id);
    Object.assign(rule, fields, { rowVersion: rule.rowVersion + 1, updatedAt: this.#iso(this.#clock()) });
    this.#persist();
    return this.#publicRule(rule);
  }
  async deleteRule(id) {
    if (!this.#rules.has(id)) return null;
    const now = this.#iso(this.#clock());
    let resolved = 0;
    for (const alert of this.#alerts) if (alert.ruleId === id && isOpen(alert)) { Object.assign(alert, { status: 'resolved', resolvedAt: now, resolvedReason: 'rule_deleted' }); resolved += 1; }
    for (const alert of this.#alerts) if (alert.ruleId === id) alert.ruleId = null;
    this.#rules.delete(id);
    for (const key of [...this.#pending.keys()]) if (key.startsWith(`${id}\n`)) this.#pending.delete(key);
    this.#persist();
    return { deleted: 1, alertsResolved: resolved };
  }

  // ---- alerts ----
  async listAlerts({ status = 'open', limit = 100 } = {}) {
    const wanted = status === 'open' ? isOpen : status === 'all' ? () => true : alert => alert.status === status;
    return this.#alerts.filter(wanted).sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, Math.min(500, Math.max(1, limit))).map(clone);
  }
  async acknowledge(id, userId) {
    const alert = this.#alerts.find(item => item.id === id);
    if (!alert) return null;
    if (alert.status === 'resolved') throw new AlertError('A resolved alert cannot be acknowledged.', 'NUV_ALERT_RESOLVED');
    if (alert.status === 'active') { Object.assign(alert, { status: 'acknowledged', acknowledgedAt: this.#iso(this.#clock()), acknowledgedBy: userId }); this.#persist(); }
    return clone(alert);
  }

  // targets: from collectTargets(). Fires, refreshes and resolves alerts as the plan says; returns what happened.
  async evaluate(targets, now = this.#clock()) {
    const rules = [...this.#rules.values()], open = this.#alerts.filter(isOpen);
    const plan = planEvaluation({ rules, targets, open, pending: this.#pending, now });
    this.#pending = plan.pending;
    const at = this.#iso(now);
    for (const { rule, target, value } of plan.fire) this.#alerts.push({ id: randomUUID(), ruleId: rule.id, ruleName: rule.name, metric: rule.metric, comparison: rule.comparison, threshold: rule.threshold, severity: rule.severity, targetKind: target.kind, targetId: target.id, targetName: target.name, connectionId: target.connectionId ?? null, value, status: 'active', firstSeenAt: at, lastSeenAt: at, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedReason: null });
    for (const { alert, rule, target, value } of plan.refresh) Object.assign(alert, { ruleName: rule.name, metric: rule.metric, comparison: rule.comparison, threshold: rule.threshold, severity: rule.severity, targetName: target.name, value, lastSeenAt: at });
    for (const { alert, reason } of plan.resolve) Object.assign(alert, { status: 'resolved', resolvedAt: at, resolvedReason: reason });
    if (plan.fire.length || plan.refresh.length || plan.resolve.length) this.#persist();
    return { fired: plan.fire.length, refreshed: plan.refresh.length, resolved: plan.resolve.length, stale: plan.stale, rules: rules.filter(rule => rule.enabled).length, evaluatedAt: at };
  }

  // ---- the notification centre ----
  async notifications(userId, { limit = 50 } = {}) {
    const lastReadAt = this.#reads.get(userId) ?? null, since = lastReadAt ?? this.#iso(this.#clock() - UNREAD_WINDOW_MS);
    const events = feedFromAlerts(this.#alerts, Math.min(200, Math.max(1, limit)));
    return { items: events, unreadCount: feedFromAlerts(this.#alerts, 1000).filter(event => event.at > since).length, lastReadAt };
  }
  async markRead(userId) { const lastReadAt = this.#iso(this.#clock()); this.#reads.set(userId, lastReadAt); this.#persist(); return { lastReadAt }; }
}
