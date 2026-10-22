// Saved views and CSV export of the inventory (docs/views.md). Pure functions, kept apart from app.js so they can be tested in node; app.js reads the filters from the page, passes them in
// and puts the HTML back. A view is the filters and the sort of the list; the server keeps each person's views and decides what a view may hold.

// ---- a view ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The filters of the list as they are now: search text, platform key, the drill ({ power, health, tag } or null) and the sort ({ key, direction } or null).
export function currentView({ search = '', platform = '', drill = null, sort = null } = {}) {
  return { search: String(search).trim(), platform: platform || '', power: drill?.power ?? null, health: drill?.health ?? null, tag: drill?.tag ?? null, sortKey: sort?.key ?? null, sortDirection: sort?.key ? (sort.direction === 'desc' ? 'desc' : 'asc') : 'asc' };
}

// What to set on the page to show a saved view: { search, platform, drill, sort }.
export function applyView(view) {
  const drill = view.power || view.health || view.tag ? { power: view.power ?? null, health: view.health ?? null, tag: view.tag ?? null } : null;
  return { search: view.search ?? '', platform: view.platform ?? '', drill, sort: view.sortKey ? { key: view.sortKey, direction: view.sortDirection === 'desc' ? 'desc' : 'asc' } : null };
}

// Whether two views filter and sort the same way (the sort direction means nothing without a column).
export function sameView(a, b) {
  const norm = view => JSON.stringify([String(view.search ?? '').trim().toLowerCase(), view.platform || '', view.power ?? null, view.health ?? null, view.tag ?? null, view.sortKey ?? null, view.sortKey ? view.sortDirection ?? 'asc' : 'asc']);
  return norm(a) === norm(b);
}

export function describeView(view, { platformLabel = value => value } = {}) {
  const parts = [];
  if (view.power) parts.push(view.power);
  if (view.health) parts.push(view.health);
  if (view.platform) parts.push(platformLabel(view.platform));
  if (view.tag) parts.push(`tag ${view.tag}`);
  if (view.search) parts.push(`search “${view.search}”`);
  if (view.sortKey) parts.push(`sorted by ${view.sortKey} (${view.sortDirection === 'desc' ? 'descending' : 'ascending'})`);
  return parts.length ? parts.join(', ') : 'everything, unsorted';
}

// ---- the Views menu -------------------------------------------------------------------------------------------------------------------------------------------------
// views: the person's saved views; active: the view the list was last set from (or null); current: the filters now. The menu is a <details> like the notification bell.
export function viewsMenuHtml(views, { active = null, current, full = false }, { esc, platformLabel }) {
  const modified = active ? !sameView(active.view, current) : false;
  const items = views.length
    ? `<ul class="views-list">${views.map(view => `<li><button type="button" class="views-item${active?.id === view.id ? ' is-active' : ''}" data-view-apply="${esc(view.id)}"${active?.id === view.id ? ' aria-current="true"' : ''}><strong>${esc(view.name)}</strong><small>${esc(describeView(view.view, { platformLabel }))}</small></button></li>`).join('')}</ul>`
    : '<p class="views-empty">No saved views yet. Set the search, filters and sort you use, then choose “Save current view”.</p>';
  const actions = [
    `<button type="button" class="text-button" data-view-save${full ? ' disabled' : ''}>Save current view…</button>`,
    active ? `<button type="button" class="text-button" data-view-update="${esc(active.id)}"${modified ? '' : ' disabled'}>Update “${esc(active.name)}” to the current filters</button><button type="button" class="text-button" data-view-rename="${esc(active.id)}">Rename “${esc(active.name)}”…</button><button type="button" class="text-button" data-view-delete="${esc(active.id)}">Delete “${esc(active.name)}”</button>` : ''
  ].join('');
  return `<div class="views-head"><strong>Views</strong>${active ? `<small>${esc(active.name)}${modified ? ' (changed)' : ''}</small>` : ''}</div>${items}${full ? '<p class="views-empty">You keep 20 views, the most there can be. Delete one to save another.</p>' : ''}<div class="views-foot">${actions}</div>`;
}

// What the summary line of the menu says: the view in use, if any.
export const viewsButtonLabel = (active, current) => (active ? `Views: ${active.name}${sameView(active.view, current) ? '' : ' (changed)'}` : 'Views');

export function saveViewDialogHtml({ mode, name = '', description = '', error = '' }, { esc }) {
  const rename = mode === 'rename';
  return `<header><div><p class="eyebrow">SAVED VIEW</p><h2 id="view-title">${rename ? 'Rename view' : 'Save current view'}</h2></div><button id="view-close" type="button">Close</button></header>
${rename ? '' : `<p class="tag-help">A saved view remembers the search, platform, power, health, tag and sort you have set now: <strong>${esc(description)}</strong>. Views are yours alone and follow you to any browser.</p>`}
<label class="alert-wide">Name<input id="view-name" name="name" maxlength="60" autocomplete="off" required value="${esc(name)}" placeholder="Running web servers"></label>
<p id="view-error" class="tag-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>
<p class="mfa-actions"><button id="view-save" type="submit" class="primary">${rename ? 'Rename' : 'Save view'}</button></p>`;
}

export function viewProblem(name) {
  if (!String(name ?? '').trim()) return 'Give the view a name.';
  if (String(name).trim().length > 60) return 'The name may have at most 60 characters.';
  return null;
}

// ---- CSV ------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The columns of an export, in the order of the file.
export const EXPORT_COLUMNS = Object.freeze(['Name', 'Platform', 'Connection', 'Power', 'Health', 'Guest OS', 'Hostname', 'IP address', 'CPU use (MHz)', 'CPU use (%)', 'Memory used (GB)', 'Memory use (%)', 'Storage used (GB)', 'Host', 'Datastores', 'Networks', 'Tags', 'Last seen']);

// One cell. A text that a spreadsheet would run as a formula (it starts with =, +, - or @, or with a tab or carriage return) is prefixed with an apostrophe so that it is shown, not run; a
// number is written as it is. Quotes, commas and line breaks are quoted as RFC 4180 says.
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// rows: arrays of values in the order of EXPORT_COLUMNS. A byte-order mark first so that Excel reads the accents, CRLF between lines.
export function toCsv(rows, columns = EXPORT_COLUMNS) {
  return `﻿${[columns, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function exportFileName(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `nuvrion-inventory-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}

// The values of one virtual machine for the file, from what the console already holds. ctx: { platform, connection, power, health, hostname, metric, storageBytes, placement: [{ label, objects: [{ name }] }] }.
const GB = 1024 ** 3, oneDecimal = value => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
export function exportRow(resource, ctx) {
  const attributes = resource.attributes ?? {}, metric = ctx.metric ?? {};
  const placed = label => (ctx.placement ?? []).find(row => row.label === label)?.objects.map(object => object.name).join('; ') ?? '';
  const ip = attributes.privateIps?.[0] ?? attributes.publicIps?.[0] ?? '';
  const tags = (resource.tags ?? []).map(tag => (tag.value ? `${tag.key}=${tag.value}` : tag.key)).join('; ');
  return [resource.name, ctx.platform, ctx.connection ?? '', ctx.power ?? '', ctx.health ?? '', attributes.guestOs ?? '', ctx.hostname ?? '', ip,
    metric.cpuUsageMhz ?? null, oneDecimal(metric.cpuUtilizationPercent), oneDecimal(metric.memoryUsedBytes == null ? null : metric.memoryUsedBytes / GB), oneDecimal(metric.memoryUtilizationPercent), oneDecimal(ctx.storageBytes == null ? null : ctx.storageBytes / GB),
    placed('Host'), placed('Datastores'), placed('Networks'), tags, resource.lastSeenAt ?? ''];
}
