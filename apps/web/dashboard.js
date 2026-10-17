// The Overview page's estate panels: how the virtual machines are doing (power and health), how each provider is doing, and the latest alerts. Pure functions,
// kept apart from app.js so they can be tested in node; app.js passes in what it already knows (how a VM's power is shown, which VMs are unreachable, how a platform
// is named) and puts the HTML in the page.
//
// Every number on the page that says "N virtual machines" is a button that opens the inventory showing exactly those N: the drill-down filter below is the same
// grouping the counts were made with, so a count and its list cannot disagree.

export const POWER_GROUPS = [
  { key: 'running', label: 'Running', tone: 'good' },
  { key: 'stopped', label: 'Stopped', tone: 'neutral' },
  { key: 'suspended', label: 'Suspended', tone: 'warn' },
  { key: 'changing', label: 'Changing state', tone: 'warn' },
  { key: 'unreachable', label: 'Unreachable', tone: 'bad' },
  { key: 'unknown', label: 'Unknown', tone: 'neutral' }
];
export const HEALTH_GROUPS = [
  { key: 'healthy', label: 'Healthy', tone: 'good' },
  { key: 'attention', label: 'Needs attention', tone: 'bad' },
  { key: 'unknown', label: 'Unknown', tone: 'neutral' }
];

const TRANSITIONS = ['rebooting', 'shutdown-pending', 'poweroff-override', 'powering-off', 'powering-on', 'suspending'];
export function powerGroup(displayPower) {
  if (displayPower === 'running' || displayPower === 'stopped' || displayPower === 'suspended' || displayPower === 'unreachable') return displayPower;
  return TRANSITIONS.includes(displayPower) ? 'changing' : 'unknown';
}

// A VM whose connection cannot be reached is not "healthy" on the strength of its last report.
export function healthGroup(resource, unreachable = false) {
  if (unreachable) return 'unknown';
  if (resource.healthState === 'healthy') return 'healthy';
  if (!resource.healthState || resource.healthState === 'unknown') return 'unknown';
  return 'attention';
}

const CONNECTION_OK = new Set(['healthy']);
const CONNECTION_DOWN = new Set(['critical', 'unhealthy']);

// resources: active VMs. context: { platformKey(resource), displayPower(resource), isUnreachable(resource), connections }
export function summarizeEstate(resources, { platformKey, displayPower, isUnreachable, connections = [] }) {
  const power = Object.fromEntries(POWER_GROUPS.map(group => [group.key, 0]));
  const health = Object.fromEntries(HEALTH_GROUPS.map(group => [group.key, 0]));
  const platforms = new Map();
  const platformOf = key => {
    if (!platforms.has(key)) platforms.set(key, { key, vmCount: 0, running: 0, attention: 0, unreachable: 0, connections: { total: 0, healthy: 0, down: 0, other: 0 }, lastSyncAt: null });
    return platforms.get(key);
  };
  for (const resource of resources) {
    const p = powerGroup(displayPower(resource)), h = healthGroup(resource, isUnreachable(resource)), platform = platformOf(platformKey(resource));
    power[p] += 1; health[h] += 1; platform.vmCount += 1;
    if (p === 'running') platform.running += 1;
    if (h === 'attention') platform.attention += 1;
    if (p === 'unreachable') platform.unreachable += 1;
  }
  for (const connection of connections) {
    if (connection.status === 'deleted') continue;
    const platform = platformOf(platformKey({ providerType: connection.providerType, connectionId: connection.id }));
    platform.connections.total += 1;
    if (CONNECTION_OK.has(connection.healthState)) platform.connections.healthy += 1;
    else if (CONNECTION_DOWN.has(connection.healthState)) platform.connections.down += 1;
    else platform.connections.other += 1;
    if (connection.lastSuccessAt && (!platform.lastSyncAt || connection.lastSuccessAt > platform.lastSyncAt)) platform.lastSyncAt = connection.lastSuccessAt;
  }
  return { total: resources.length, power, health, platforms: [...platforms.values()].sort((a, b) => b.vmCount - a.vmCount || a.key.localeCompare(b.key)) };
}

// Open alerts first (critical before warning, newest first), then the ones that recovered, newest first.
export function recentAlerts(alerts, limit = 5) {
  const open = alert => (['active', 'acknowledged'].includes(alert.status) ? 0 : 1);
  const severity = alert => (alert.severity === 'critical' ? 0 : 1);
  return [...alerts].sort((a, b) => open(a) - open(b) || (open(a) === 0 ? severity(a) - severity(b) : 0) || String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? ''))).slice(0, limit);
}

// The filter a click on the Overview applies to the inventory: { power, health }, each optional. (The platform is the inventory's own selector, which shows what it is set to.)
export function matchesDrill(resource, drill, { displayPower, isUnreachable }) {
  if (!drill) return true;
  if (drill.power && powerGroup(displayPower(resource)) !== drill.power) return false;
  if (drill.health && healthGroup(resource, isUnreachable(resource)) !== drill.health) return false;
  return true;
}

export const drillIsEmpty = drill => !drill || (!drill.power && !drill.health);
export const powerLabel = key => POWER_GROUPS.find(group => group.key === key)?.label ?? key;
export const healthLabel = key => HEALTH_GROUPS.find(group => group.key === key)?.label ?? key;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- HTML ----------------------------------------------------------------------------------------------------------------------------------------------------

function breakdownHtml(title, groups, counts, total, attribute, { esc }) {
  const present = groups.filter(group => counts[group.key] > 0);
  if (!total) return '';
  const bar = present.map(group => `<span class="breakdown-segment tone-${group.tone}" style="width:${(counts[group.key] / total * 100).toFixed(2)}%"></span>`).join('');
  const rows = groups.map(group => {
    const n = counts[group.key];
    return n
      ? `<li><button type="button" class="breakdown-row" ${attribute}="${esc(group.key)}" ><span class="breakdown-dot tone-${group.tone}" aria-hidden="true"></span><span class="breakdown-label">${esc(group.label)}</span><strong>${n}</strong><span class="sr-only"> ${n === 1 ? 'virtual machine' : 'virtual machines'}. Show them in the inventory.</span></button></li>`
      : `<li class="breakdown-zero"><span class="breakdown-dot tone-${group.tone}" aria-hidden="true"></span><span class="breakdown-label">${esc(group.label)}</span><strong>0</strong></li>`;
  }).join('');
  return `<section class="breakdown"><h3>${esc(title)}</h3><div class="breakdown-bar" aria-hidden="true">${bar}</div><ul>${rows}</ul></section>`;
}

export function estateHealthHtml(summary, { esc }) {
  if (!summary.total) return '<div class="empty compact"><strong>No inventory yet</strong><p>Add a connection to begin discovery.</p></div>';
  return breakdownHtml('Power', POWER_GROUPS, summary.power, summary.total, 'data-drill-power', { esc }) + breakdownHtml('Health', HEALTH_GROUPS, summary.health, summary.total, 'data-drill-health', { esc });
}

export function providerOverviewHtml(summary, { esc, labelOf, when }) {
  if (!summary.platforms.length) return '<div class="empty compact"><strong>No providers connected</strong><p>Add a connection to see how each provider is doing.</p></div>';
  return `<div class="provider-grid">${summary.platforms.map(platform => {
    const c = platform.connections, down = c.down > 0, label = labelOf(platform.key);
    const connectionText = c.total === 0 ? 'No connection' : down ? `${c.down} of ${plural(c.total, 'connection')} unreachable` : c.healthy === c.total ? plural(c.total, 'connection') + ' healthy' : plural(c.total, 'connection');
    const tone = c.total === 0 ? 'neutral' : down ? 'bad' : c.healthy === c.total ? 'good' : 'warn';
    return `<button type="button" class="provider-card tone-${tone}" data-drill-platform="${esc(platform.key)}">`
      + `<span class="provider-name">${esc(label)}</span>`
      + `<strong class="provider-count">${platform.vmCount}<small> VM${platform.vmCount === 1 ? '' : 's'}</small></strong>`
      + `<span class="provider-line">${platform.running} running${platform.attention ? ` · ${platform.attention} need attention` : ''}${platform.unreachable ? ` · ${platform.unreachable} unreachable` : ''}</span>`
      + `<span class="provider-line provider-connections"><span class="breakdown-dot tone-${tone}" aria-hidden="true"></span>${esc(connectionText)}</span>`
      + `<span class="provider-line provider-sync">${platform.lastSyncAt ? `Last sync ${esc(when(platform.lastSyncAt))}` : 'Not synced yet'}</span><span class="sr-only">Show them in the inventory.</span></button>`;
  }).join('')}</div>`;
}

export function recentAlertsHtml(alerts, { esc, when, badge, reasonOf, connectionNameOf }) {
  if (!alerts.length) return '<div class="empty compact"><strong>No alerts</strong><p>Connection problems appear here as they happen.</p></div>';
  return `<ul class="alert-list">${alerts.map(alert => {
    const open = ['active', 'acknowledged'].includes(alert.status);
    return `<li><button type="button" class="alert-row${open ? ' is-open' : ''}" data-drill-alerts="true">`
      + `${badge(alert.severity)}<span class="alert-text"><strong>${esc(connectionNameOf(alert))}</strong><small>${esc(reasonOf(alert.errorCode))}${alert.occurrenceCount > 1 ? ` · seen ${alert.occurrenceCount} times` : ''} · ${esc(when(alert.lastSeenAt))}</small></span>${badge(alert.status)}<span class="sr-only">Open the alert history.</span></button></li>`;
  }).join('')}</ul>`;
}

// The chips above the inventory that say why the list is shorter than the estate.
export function drillChipsHtml(drill, { esc }) {
  const chips = [];
  if (drill?.power) chips.push(['power', `Power: ${powerLabel(drill.power)}`]);
  if (drill?.health) chips.push(['health', `Health: ${healthLabel(drill.health)}`]);
  if (!chips.length) return '';
  return chips.map(([kind, text]) => `<span class="drill-chip">${esc(text)}<button type="button" data-clear-drill="${kind}" aria-label="Remove filter ${esc(text)}"><span aria-hidden="true">✕</span></button></span>`).join('')
    + '<button type="button" class="text-button" data-clear-drill="all">Clear filters</button>';
}
