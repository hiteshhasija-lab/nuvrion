// Saved views (docs/views.md): what a saved view of the inventory may contain. A view is the filters and the sort order of the list: the search text, the platform, the power and health
// the Overview drilled into, a tag, and the column the list is sorted by. Pure functions, shared by both stores and the API so they cannot disagree.
export const LIMITS = Object.freeze({ perPerson: 20, nameMax: 60, searchMax: 100, tagMax: 200 });
export const SORT_KEYS = Object.freeze(['name', 'status', 'guestOs', 'hostname', 'power', 'ip', 'cpu', 'memory', 'storage']);
const TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;

export class ViewError extends Error {
  constructor(message, code = 'NUV_VIEW_INVALID') { super(message); this.code = code; }
}

const plainText = (raw, label, max, { required = false } = {}) => {
  const text = String(raw ?? '').trim();
  if (required && !text) throw new ViewError(`A ${label} is needed.`);
  if (text.length > max) throw new ViewError(`The ${label} may have at most ${max} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) throw new ViewError(`The ${label} may not contain control or invisible formatting characters.`);
  return text;
};

export const parseName = raw => plainText(raw, 'name', LIMITS.nameMax, { required: true });

// The filters and sort of a view, cleaned: { search, platform, power, health, tag, sortKey, sortDirection }. Anything not listed here is refused, not ignored.
export function parseView(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ViewError('The view must be an object.');
  const allowed = ['search', 'platform', 'power', 'health', 'tag', 'sortKey', 'sortDirection'];
  const unknown = Object.keys(raw).find(key => !allowed.includes(key));
  if (unknown) throw new ViewError(`Unknown field in the view: ${unknown.slice(0, 40)}.`);
  const token = (value, label) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !TOKEN.test(value)) throw new ViewError(`The ${label} of a view must be a short lower case word.`);
    return value;
  };
  const sortKey = raw.sortKey === undefined || raw.sortKey === null || raw.sortKey === '' ? null : raw.sortKey;
  if (sortKey !== null && !SORT_KEYS.includes(sortKey)) throw new ViewError(`sortKey must be one of ${SORT_KEYS.join(', ')}.`);
  const sortDirection = raw.sortDirection ?? 'asc';
  if (!['asc', 'desc'].includes(sortDirection)) throw new ViewError('sortDirection must be "asc" or "desc".');
  const tag = plainText(raw.tag ?? '', 'tag', LIMITS.tagMax);
  return { search: plainText(raw.search ?? '', 'search', LIMITS.searchMax), platform: token(raw.platform, 'platform') ?? '', power: token(raw.power, 'power'), health: token(raw.health, 'health'), tag: tag || null, sortKey, sortDirection: sortKey ? sortDirection : 'asc' };
}

export function parseCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ViewError('The request must be a JSON object.');
  const unknown = Object.keys(body).find(key => !['name', 'view'].includes(key));
  if (unknown) throw new ViewError(`Unknown field: ${unknown.slice(0, 40)}.`);
  return { name: parseName(body.name), view: parseView(body.view) };
}

export function parseChange(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ViewError('The request must be a JSON object.');
  const unknown = Object.keys(body).find(key => !['name', 'view'].includes(key));
  if (unknown) throw new ViewError(`Unknown field: ${unknown.slice(0, 40)}.`);
  if (body.name === undefined && body.view === undefined) throw new ViewError('Nothing to change.');
  return { ...(body.name !== undefined ? { name: parseName(body.name) } : {}), ...(body.view !== undefined ? { view: parseView(body.view) } : {}) };
}

// The rows an export may hold are decided by the console; the server only needs to know that an export happened and how big it was (docs/views.md).
export function parseExportNote(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ViewError('The request must be a JSON object.');
  const unknown = Object.keys(body).find(key => !['count', 'columns', 'view'].includes(key));
  if (unknown) throw new ViewError(`Unknown field: ${unknown.slice(0, 40)}.`);
  const count = body.count;
  if (!Number.isInteger(count) || count < 0 || count > 1_000_000) throw new ViewError('count must be a whole number of rows.');
  const columns = body.columns === undefined ? null : body.columns;
  if (columns !== null && (!Number.isInteger(columns) || columns < 1 || columns > 100)) throw new ViewError('columns must be a whole number from 1 to 100.');
  return { count, columns, view: body.view === undefined ? null : parseView(body.view) };
}

// A view in words, for menus and the audit history: "running, VMware ESXi, tag env=prod, search “web”, sorted by memory (descending)".
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
