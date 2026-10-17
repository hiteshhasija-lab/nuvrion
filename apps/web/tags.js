// Tags in the console (docs/tagging.md): how a tag is shown, how the inventory is filtered by one, and the dialog that sets and removes them. Pure functions, kept
// apart from app.js so they can be tested in node; app.js passes in `esc` and puts the HTML in the page. The server (modules/inventory/src/tag-rules.js) is the judge of
// what a valid tag is; what is checked here only saves a round trip.
//
// A resource's tags arrive in one list: the ones Nuvrion holds first (source "nuvrion", changeable here), then the ones the provider reports (source "provider", shown but
// never changed from here, so a tag we wrote can never hide or replace one the provider has).

export const MAX_CHIPS = 3;
export const MAX_VALUES_AS_OPTIONS = 12;

export const tagText = tag => (tag.value ? `${tag.key}: ${tag.value}` : tag.key);
const ownTags = resource => (resource.tags ?? []).filter(tag => tag.source === 'nuvrion');
const providerTagsOf = resource => (resource.tags ?? []).filter(tag => tag.source === 'provider');

export function tagChipsHtml(tags, { esc, max = MAX_CHIPS } = {}) {
  if (!tags?.length) return '';
  const shown = tags.slice(0, max), hidden = tags.slice(max);
  const chip = tag => `<span class="tag-chip ${tag.source === 'provider' ? 'is-provider' : ''}" title="${esc(tag.source === 'provider' ? `${tagText(tag)} (reported by the provider)` : tagText(tag))}">${esc(tagText(tag))}</span>`;
  const more = hidden.length ? `<span class="tag-chip is-more" title="${esc(hidden.map(tagText).join(', '))}">+${hidden.length}</span>` : '';
  return `<span class="tag-chips">${shown.map(chip).join('')}${more}</span>`;
}

// "env" (any value) and "env=prod" (that value), for the filter list. Keys with many values are offered as the key only.
export function tagFilterOptions(resources) {
  const keys = new Map();
  for (const resource of resources) for (const tag of resource.tags ?? []) {
    const lower = tag.key.toLowerCase(), entry = keys.get(lower) ?? { key: tag.key, resources: new Set(), values: new Map() };
    entry.resources.add(resource.id); entry.values.set(tag.value, (entry.values.get(tag.value) ?? new Set()).add(resource.id)); keys.set(lower, entry);
  }
  const options = [];
  for (const [lower, entry] of [...keys].sort(([a], [b]) => (a < b ? -1 : 1))) {
    options.push({ value: lower, label: `${entry.key} (any value)`, count: entry.resources.size });
    if (entry.values.size > 1 && entry.values.size <= MAX_VALUES_AS_OPTIONS) {
      for (const [value, ids] of [...entry.values].sort(([a], [b]) => (a < b ? -1 : 1))) options.push({ value: `${lower}=${value}`, label: `${entry.key} = ${value || '(empty)'}`, count: ids.size });
    } else if (entry.values.size === 1) {
      const [[value, ids]] = [...entry.values];
      if (value) options.push({ value: `${lower}=${value}`, label: `${entry.key} = ${value}`, count: ids.size });
    }
  }
  return options;
}

// The same meaning as the server's ?tag= filter: "key" matches any value, "key=value" that value; keys in lower case, values exactly.
export function matchesTagSpec(resource, spec) {
  if (!spec) return true;
  const at = spec.indexOf('='), key = (at < 0 ? spec : spec.slice(0, at)).trim().toLowerCase(), value = at < 0 ? undefined : spec.slice(at + 1).trim();
  return (resource.tags ?? []).some(tag => tag.key.toLowerCase() === key && (value === undefined || tag.value === value));
}

export function tagFilterOptionsHtml(options, selected, { esc }) {
  return `<option value="">All tags</option>${options.map(option => `<option value="${esc(option.value)}"${option.value === selected ? ' selected' : ''}>${esc(option.label)} · ${option.count}</option>`).join('')}`;
}

// ---- the dialog ------------------------------------------------------------------------------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the dialog shows for the selected resources: the tags Nuvrion holds with how many of the resources carry each, and the provider's, for a single resource.
export function tagDialogModel(resources) {
  const counts = new Map();
  for (const resource of resources) for (const tag of ownTags(resource)) {
    const id = JSON.stringify([tag.key, tag.value]), entry = counts.get(id) ?? { key: tag.key, value: tag.value, count: 0 };
    entry.count += 1; counts.set(id, entry);
  }
  const own = [...counts.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value < b.value ? -1 : 1));
  return { total: resources.length, own, provider: resources.length === 1 ? providerTagsOf(resources[0]) : [] };
}

export function tagDialogHtml(resources, { esc, keysInUse = [], canEdit = true }) {
  const model = tagDialogModel(resources), n = model.total;
  const subject = n === 1 ? resources[0].name : plural(n, 'virtual machine');
  const ownList = model.own.length
    ? `<ul class="tag-list">${model.own.map(tag => `<li><span class="tag-chip">${esc(tagText(tag))}</span><small>${n === 1 ? '' : tag.count === n ? `on all ${n}` : `on ${tag.count} of ${n}`}</small>${canEdit
      ? `<button type="button" class="text-button" data-tag-remove="${esc(tag.key)}" aria-label="Remove tag ${esc(tag.key)} from ${n === 1 ? esc(resources[0].name) : `all ${n} virtual machines`}">Remove</button>` : ''}</li>`).join('')}</ul>`
    : `<p class="tag-empty">No tags set by Nuvrion yet.</p>`;
  const providerList = model.provider.length
    ? `<h3>Reported by the provider</h3><p class="tag-help">These come from ${esc(resources[0].providerType === 'azure' ? 'Azure' : resources[0].providerType === 'aws' ? 'AWS' : 'the provider')} and are changed there, not here.</p><ul class="tag-list">${model.provider.map(tag => `<li><span class="tag-chip is-provider">${esc(tagText(tag))}</span></li>`).join('')}</ul>` : '';
  const form = canEdit
    ? `<section class="tag-set"><h3>Add or change a tag</h3><div class="tag-fields"><label>Key<input id="tag-key" list="tag-keys" maxlength="64" autocomplete="off" required placeholder="env"></label><label>Value<input id="tag-value" maxlength="128" autocomplete="off" placeholder="prod (optional)"></label></div><datalist id="tag-keys">${keysInUse.map(key => `<option value="${esc(key)}"></option>`).join('')}</datalist><p class="tag-help">Keys are lower case and may use letters, digits and . _ : / - . Setting a key that exists changes its value.</p><p id="tag-error" class="tag-error" role="alert" hidden></p><button id="tag-set" type="submit" class="primary">Set on ${esc(n === 1 ? 'this virtual machine' : `${n} virtual machines`)}</button></section>`
    : '<p class="tag-help">Your role can see tags but not change them.</p>';
  return `<header><div><p class="eyebrow">TAGS</p><h2 id="tag-title">${esc(subject)}</h2></div><button id="tag-close" type="button">Close</button></header><section><h3>Set by Nuvrion</h3>${ownList}${providerList}</section>${form}`;
}

// The request body for the API. `keys` are removed, `set` is [{ key, value }].
export const tagOperationBody = (resourceIds, { set = [], remove = [] } = {}) => ({ resourceIds, ...(set.length ? { set } : {}), ...(remove.length ? { remove } : {}) });

export function tagResultText(result, { set = [], remove = [] } = {}) {
  const changed = result.changedCount, total = result.count;
  const what = set.length ? `Tag ${set[0].key}${set[0].value ? `: ${set[0].value}` : ''} set` : `Tag ${remove[0]} removed`;
  return changed === 0 ? `Nothing changed: ${plural(total, 'virtual machine')} already had it that way.` : `${what} on ${plural(changed, 'virtual machine')}.`;
}
