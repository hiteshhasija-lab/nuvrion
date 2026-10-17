// Nuvrion's own tags on resources (docs/tagging.md): what a tag may look like, how a request is validated, and what a request changes.
//
// A tag is a key with an optional value, attached to a resource by Nuvrion (source "nuvrion"). Tags that the provider reports (Azure and AWS tags, in the
// resource's attributes) are shown beside them (source "provider") but are not changed from here: a tag Nuvrion wrote can never hide or overwrite one the provider has.
// Keys are lower case (a key typed as "Env" is "env"), so "Env" and "env" cannot both exist. Both stores (the local file and PostgreSQL) use the functions below, so
// they cannot disagree about what is valid or what a request does.

export const TAG_LIMITS = Object.freeze({ keyLength: 64, valueLength: 128, perResource: 50, resourcesPerRequest: 200, changesPerRequest: 20 });
export const RESERVED_PREFIXES = Object.freeze(['nuvrion:', 'aws:', 'azure:', 'vmware:', 'microsoft:']);
const KEY = /^[a-z0-9][a-z0-9._:/-]*$/;
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TagError extends Error {
  constructor(message, code = 'NUV_TAG_REQUEST_INVALID') { super(message); this.code = code; }
}

export function normaliseKey(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) throw new TagError('A tag needs a key.');
  if (key.length > TAG_LIMITS.keyLength) throw new TagError(`A tag key may have at most ${TAG_LIMITS.keyLength} characters.`);
  if (!KEY.test(key)) throw new TagError(`The tag key "${key.slice(0, 40)}" may use only letters, digits and . _ : / - , and must start with a letter or digit.`);
  const reserved = RESERVED_PREFIXES.find(prefix => key.startsWith(prefix));
  if (reserved) throw new TagError(`Tag keys starting with "${reserved}" are reserved.`);
  return key;
}

export function normaliseValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.length > TAG_LIMITS.valueLength) throw new TagError(`A tag value may have at most ${TAG_LIMITS.valueLength} characters.`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw new TagError('A tag value may not contain control or invisible formatting characters.');
  return value;
}

// body: { resourceIds: [...], set: [{ key, value }], remove: [key] } -> the same, validated and normalised. Throws TagError.
export function parseTagOperation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TagError('The request must be a JSON object.');
  const unknown = Object.keys(body).filter(name => !['resourceIds', 'set', 'remove'].includes(name));
  if (unknown.length) throw new TagError(`Unknown field: ${unknown[0].slice(0, 40)}.`);
  const { resourceIds, set = [], remove = [] } = body;
  if (!Array.isArray(resourceIds) || !resourceIds.length) throw new TagError('resourceIds must list at least one resource.');
  if (resourceIds.length > TAG_LIMITS.resourcesPerRequest) throw new TagError(`A request may change at most ${TAG_LIMITS.resourcesPerRequest} resources.`);
  for (const id of resourceIds) if (typeof id !== 'string' || !RESOURCE_ID.test(id)) throw new TagError('resourceIds must be resource identifiers.');
  if (!Array.isArray(set) || !Array.isArray(remove)) throw new TagError('set and remove must be lists.');
  if (!set.length && !remove.length) throw new TagError('Nothing to change: give at least one tag to set or remove.');
  if (set.length > TAG_LIMITS.changesPerRequest || remove.length > TAG_LIMITS.changesPerRequest) throw new TagError(`A request may set at most ${TAG_LIMITS.changesPerRequest} tags and remove at most ${TAG_LIMITS.changesPerRequest}.`);
  const settings = new Map();
  for (const item of set) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TagError('Each tag to set must be an object with a key and a value.');
    const key = normaliseKey(item.key);
    if (settings.has(key)) throw new TagError(`The tag "${key}" is set twice.`);
    settings.set(key, normaliseValue(item.value));
  }
  const removals = new Set();
  for (const raw of remove) {
    if (typeof raw !== 'string') throw new TagError('Each tag to remove must be a key.');
    const key = normaliseKey(raw);
    if (settings.has(key)) throw new TagError(`The tag "${key}" cannot be both set and removed.`);
    removals.add(key);
  }
  return { resourceIds: [...new Set(resourceIds.map(id => id.toLowerCase()))], set: [...settings].map(([key, value]) => ({ key, value })), remove: [...removals] };
}

// existing: Map resourceId -> Map key -> value. Returns, for each resource in the request, what changes and what its tags are afterwards:
//   { resourceId, added: [{key,value}], changed: [{key,from,value}], removed: [{key,value}], after: [{key,value}], changedAnything }
// Throws TagError (and changes nothing) if any resource would end up with more tags than the limit.
export function planTagChanges(existing, operation) {
  const plan = [];
  for (const resourceId of operation.resourceIds) {
    const before = existing.get(resourceId) ?? new Map(), after = new Map(before), added = [], changed = [], removed = [];
    for (const { key, value } of operation.set) {
      if (!before.has(key)) added.push({ key, value });
      else if (before.get(key) !== value) changed.push({ key, from: before.get(key), value });
      after.set(key, value);
    }
    for (const key of operation.remove) if (before.has(key)) { removed.push({ key, value: before.get(key) }); after.delete(key); }
    if (after.size > TAG_LIMITS.perResource) throw new TagError(`A resource may have at most ${TAG_LIMITS.perResource} tags; this change would give one ${after.size}.`, 'NUV_TAG_LIMIT_EXCEEDED');
    plan.push({ resourceId, added, changed, removed, after: [...after].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value })), changedAnything: Boolean(added.length || changed.length || removed.length) });
  }
  return plan;
}

// The tags a provider reports in a resource's attributes (an object of key -> value; Azure and AWS), as read-only entries.
export function providerTags(attributes) {
  const raw = attributes?.tags;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw).filter(([key]) => key).slice(0, 200).map(([key, value]) => ({ key: String(key).slice(0, 128), value: String(value ?? '').slice(0, 256), source: 'provider' }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

// "env" matches any value of the key; "env=prod" matches that value (keys are compared lower case, values exactly).
export function parseTagFilter(text) {
  const raw = String(text ?? '');
  const at = raw.indexOf('=');
  const key = (at < 0 ? raw : raw.slice(0, at)).trim().toLowerCase();
  if (!key) throw new TagError('A tag filter needs a key.');
  return at < 0 ? { key } : { key, value: raw.slice(at + 1).trim() };
}
export const matchesTagFilter = (tags, filter) => tags.some(tag => tag.key.toLowerCase() === filter.key && (filter.value === undefined || tag.value === filter.value));
