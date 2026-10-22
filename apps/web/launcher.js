// The command launcher (docs/launcher.md): Ctrl or Cmd + K opens a box in which a few letters find a page, a virtual machine, a host or datastore, a saved view or something to create, and Enter goes
// there. Pure functions, kept apart from app.js so they can be tested in node: they build the list of things the person may do, rank it against what was typed, and write the HTML of the box.
// Nothing here changes anything: a command only takes the person to a page or opens the dialog they would have opened by hand, so every confirmation and every permission check stays where it was.

export const LIMIT = 12;
export const RECENT_MAX = 5;

const has = (permissions, permission) => !permission || permissions.includes(permission);

// ---- what can be done -------------------------------------------------------------------------------------------------------------------------------------------------------
const PAGES = [
  { id: 'page:overview', title: 'Overview', view: 'overview', keywords: 'dashboard home summary estate' },
  { id: 'page:inventory', title: 'Virtual machines', view: 'inventory', keywords: 'inventory vms servers list' },
  { id: 'page:infrastructure', title: 'Infrastructure', view: 'infrastructure', keywords: 'hosts clusters datastores networks datacenters tree hierarchy' },
  { id: 'page:connections', title: 'Connections', view: 'connections', permission: 'connection.view', keywords: 'providers vcenter esxi workstation agents endpoints credentials' },
  { id: 'page:monitor', title: 'Monitor', view: 'monitor', keywords: 'performance charts metrics' },
  { id: 'page:alert-rules', title: 'Alert rules', view: 'alert-rules', keywords: 'alerts thresholds notifications webhooks bell' },
  { id: 'page:schedules', title: 'Schedules', view: 'schedules', keywords: 'scheduled operations power on off start stop restart cron timer' },
  { id: 'page:capacity', title: 'Capacity', view: 'capacity', keywords: 'forecast days until full storage datastore cpu memory host cluster growth' },
  { id: 'page:users', title: 'Users', view: 'users', permission: 'identity.manage', keywords: 'accounts roles permissions mfa two-step passwords people' },
  { id: 'page:health', title: 'Platform health', view: 'health', keywords: 'status readiness metrics upgrade version' }
];
const MONITOR_TABS = [
  { id: 'monitor:performance', title: 'Performance', tab: 'performance', keywords: 'charts cpu memory metrics' },
  { id: 'monitor:alerts', title: 'Connection alerts', tab: 'alerts', keywords: 'alert history incidents connection health' },
  { id: 'monitor:tasks', title: 'Task history', tab: 'tasks', keywords: 'tasks operations jobs activity' },
  { id: 'monitor:audit', title: 'Audit history', tab: 'audit', permission: 'audit.view', keywords: 'audit log events who did what' }
];
const ACTIONS = [
  { id: 'action:new-connection', title: 'Add a connection', permission: 'connection.manage', action: 'new-connection', keywords: 'new provider vcenter esxi workstation aws azure' },
  { id: 'action:new-alert-rule', title: 'New alert rule', permission: 'alert.manage', action: 'new-alert-rule', keywords: 'threshold create alert' },
  { id: 'action:new-webhook', title: 'New webhook', permission: 'alert.manage', action: 'new-webhook', keywords: 'notification slack teams chat send alerts' },
  { id: 'action:new-schedule', title: 'New schedule', permission: 'schedule.manage', action: 'new-schedule', keywords: 'scheduled operation start stop restart timer' },
  { id: 'action:save-view', title: 'Save the current inventory view…', action: 'save-view', keywords: 'filters sort search remember' },
  { id: 'action:export', title: 'Export the inventory to CSV', action: 'export', keywords: 'download spreadsheet excel csv' },
  { id: 'action:refresh', title: 'Refresh the data', action: 'refresh', keywords: 'reload update discovery' },
  { id: 'action:sessions', title: 'My sessions', action: 'sessions', keywords: 'signed in devices revoke account' },
  { id: 'action:sign-out', title: 'Sign out', action: 'sign-out', keywords: 'log out logout' }
];

// ctx: { permissions: [], machines: [{ id, name, detail }], objects: [{ id, name, kind, detail }], views: [{ id, name, detail }], extra: [ ...commands ] }. Returns [{ id, group, title, detail, keywords, run }].
export function buildCommands({ permissions = [], machines = [], objects = [], views = [], extra = [] } = {}) {
  const allowed = list => list.filter(item => has(permissions, item.permission));
  return [
    ...allowed(PAGES).map(page => ({ id: page.id, group: 'Go to', title: page.title, detail: '', keywords: page.keywords, run: { type: 'view', view: page.view } })),
    ...allowed(MONITOR_TABS).map(tab => ({ id: tab.id, group: 'Go to', title: tab.title, detail: 'Monitor', keywords: tab.keywords, run: { type: 'monitor', tab: tab.tab } })),
    ...allowed(ACTIONS).map(action => ({ id: action.id, group: 'Do', title: action.title, detail: '', keywords: action.keywords, run: { type: 'action', action: action.action } })),
    ...extra,
    ...views.map(view => ({ id: `view:${view.id}`, group: 'Views', title: view.name, detail: view.detail ?? 'Saved view', keywords: 'view filter saved', run: { type: 'view-apply', id: view.id } })),
    ...objects.map(object => ({ id: `infra:${object.id}`, group: 'Infrastructure', title: object.name, detail: object.detail ?? object.kind, keywords: `${object.kind} ${object.detail ?? ''}`, run: { type: 'infrastructure', id: object.id } })),
    ...machines.map(machine => ({ id: `vm:${machine.id}`, group: 'Virtual machines', title: machine.name, detail: machine.detail ?? '', keywords: `vm machine ${machine.detail ?? ''}`, run: { type: 'machine', id: machine.id } }))
  ];
}

// ---- ranking ------------------------------------------------------------------------------------------------------------------------------------------------------------------
const norm = value => String(value ?? '').toLowerCase();
const words = text => norm(text).split(/[^a-z0-9]+/).filter(Boolean);
const subsequence = (needle, haystack) => { let at = 0; for (const char of needle) { at = haystack.indexOf(char, at); if (at < 0) return false; at++; } return true; };

// How well a command answers what was typed: 0 means not at all. Every word typed has to be found (in the title, the detail or the keywords); words at the start of a word of the title count most.
export function scoreCommand(query, command) {
  const typed = norm(query).split(/\s+/).filter(Boolean);
  if (!typed.length) return 1;
  const title = norm(command.title), titleWords = words(command.title), rest = `${norm(command.detail)} ${norm(command.keywords)}`;
  let score = 0;
  for (const word of typed) {
    if (title === word) score += 12;
    else if (title.startsWith(word)) score += 9;
    else if (titleWords.some(candidate => candidate.startsWith(word))) score += 6;
    else if (title.includes(word)) score += 4;
    else if (rest.includes(word)) score += 2;
    else if (word.length >= 3 && subsequence(word, title)) score += 1;
    else return 0;
  }
  return score + Math.max(0, 3 - title.length / 20);       // among equals, the shorter title is the nearer answer
}

const GROUP_ORDER = ['Go to', 'Do', 'Views', 'Infrastructure', 'Virtual machines'];
// The commands to show for what was typed: best first, at most `limit`. With nothing typed: the ones used lately, then the pages.
export function rankCommands(commands, query, { recent = [], limit = LIMIT } = {}) {
  if (!norm(query).trim()) {
    const byId = new Map(commands.map(command => [command.id, command]));
    const lately = recent.map(id => byId.get(id)).filter(Boolean);
    const rest = commands.filter(command => command.group === 'Go to' && !recent.includes(command.id));
    return [...lately.map(command => ({ ...command, recent: true })), ...rest].slice(0, limit);
  }
  return commands.map(command => ({ command, score: scoreCommand(query, command) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || GROUP_ORDER.indexOf(a.command.group) - GROUP_ORDER.indexOf(b.command.group) || a.command.title.localeCompare(b.command.title))
    .slice(0, limit).map(item => item.command);
}

// The recent list after running a command: the newest first, once each, at most RECENT_MAX.
export const rememberCommand = (recent, id) => [id, ...recent.filter(item => item !== id)].slice(0, RECENT_MAX);

// The next position in a list of `count` options when an arrow key is pressed; it wraps round.
export function moveActive(active, count, key) {
  if (!count) return -1;
  if (key === 'ArrowDown') return active < 0 || active >= count - 1 ? 0 : active + 1;
  if (key === 'ArrowUp') return active <= 0 ? count - 1 : active - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return active;
}

// ---- the box -------------------------------------------------------------------------------------------------------------------------------------------------------------------
export const shellHtml = ({ hint }) => `<header><div><p class="eyebrow">COMMAND LAUNCHER</p><h2 id="launcher-title">Go to or do</h2></div><button id="launcher-close" type="button">Close</button></header>
<div class="launcher-box"><label class="sr-only" for="launcher-input">Type to find a page, a machine, a view or something to do</label><input id="launcher-input" type="text" role="combobox" aria-expanded="true" aria-controls="launcher-list" aria-autocomplete="list" aria-activedescendant="" autocomplete="off" spellcheck="false" placeholder="Type to find a page, a machine, a view or something to do"></div>
<ul id="launcher-list" class="launcher-list" role="listbox" aria-label="Results"></ul>
<p id="launcher-status" class="sr-only" role="status" aria-live="polite"></p>
<p class="launcher-hint" aria-hidden="true">${hint}</p>`;

export function resultsHtml(results, active, { esc }) {
  if (!results.length) return '<li class="launcher-empty" role="option" aria-disabled="true" aria-selected="false">Nothing matches. Try part of a name, or a word such as “alert”, “schedule” or “capacity”.</li>';
  return results.map((command, index) => `<li id="launcher-option-${index}" class="launcher-option${index === active ? ' is-active' : ''}" role="option" aria-selected="${index === active}" data-launcher-index="${index}"><span class="launcher-title">${esc(command.title)}</span>${command.detail ? `<small class="launcher-detail">${esc(command.detail)}</small>` : ''}<span class="launcher-group">${esc(command.recent ? 'Recent' : command.group)}</span></li>`).join('');
}

export const statusText = (results, query) => (results.length ? `${results.length} result${results.length === 1 ? '' : 's'}${query.trim() ? '' : ', recent and pages'}. Use the arrow keys and Enter.` : 'No results.');
