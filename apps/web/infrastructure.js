// The Infrastructure page (docs/infrastructure.md): the datacenters, clusters, hosts, datastores and networks providers report, as a tree with a panel for what is selected, and the
// rows that say where a virtual machine runs. Pure functions, kept apart from app.js so they can be tested in node; app.js passes in what it knows (escaping, platform names, how a VM's
// power is shown) and puts the HTML in the page.
//
// The page has no data of its own: every number comes from the objects the API lists and the placement each VM reports, joined by identifier within one connection. When a connection
// cannot be reached what is shown is what was last seen, and says so.

export const KIND_LABELS = Object.freeze({ datacenter: 'Datacenter', cluster: 'Cluster', host: 'Host', datastore: 'Datastore', network: 'Network' });
const KIND_PLURALS = Object.freeze({ datacenter: 'Datacenters', cluster: 'Clusters', host: 'Hosts', datastore: 'Datastores', network: 'Networks' });
const PARENT_KINDS = ['datacenter', 'cluster'];
const DOWN = new Set(['critical', 'unhealthy']);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const key = (connectionId, nativeId) => `${connectionId}\n${nativeId}`;

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}
const formatMhz = value => (Number.isFinite(value) ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')} GHz` : '—');
const formatUptime = seconds => {
  if (!Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600);
  return days ? `${days} day${days === 1 ? '' : 's'} ${hours} h` : hours ? `${hours} h` : `${Math.floor(seconds / 60)} min`;
};
const tone = percent => (percent >= 90 ? 'bad' : percent >= 75 ? 'warn' : 'good');

// objects: what GET /infrastructure lists. resources: the VMs. connections: for names and reachability.
export function buildIndex(objects, resources, connections) {
  const live = objects.filter(object => object.lifecycleState !== 'deleted');
  const byId = new Map(live.map(object => [object.id, object]));
  const byNative = new Map(live.map(object => [`${object.connectionId}\n${object.kind}\n${object.nativeId}`, object]));
  const parentOf = object => (object.parentNativeId ? PARENT_KINDS.map(kind => byNative.get(`${object.connectionId}\n${kind}\n${object.parentNativeId}`)).find(Boolean) ?? null : null);
  const children = new Map(), roots = new Map();
  for (const object of live) {
    const parent = parentOf(object);
    const list = parent ? children.get(parent.id) ?? children.set(parent.id, []).get(parent.id) : roots.get(object.connectionId) ?? roots.set(object.connectionId, []).get(object.connectionId);
    list.push(object);
  }
  const vmsOf = new Map(), placed = new Set();
  const link = (object, vm) => { if (!object) return; (vmsOf.get(object.id) ?? vmsOf.set(object.id, []).get(object.id)).push(vm); };
  for (const vm of resources) {
    const placement = vm.providerMetadata?.placement;
    if (!placement) continue;
    placed.add(vm.id);
    link(byNative.get(`${vm.connectionId}\nhost\n${placement.hostNativeId}`), vm);
    for (const id of placement.datastoreNativeIds ?? []) link(byNative.get(`${vm.connectionId}\ndatastore\n${id}`), vm);
    for (const id of placement.networkNativeIds ?? []) link(byNative.get(`${vm.connectionId}\nnetwork\n${id}`), vm);
  }
  const connectionById = new Map(connections.map(connection => [connection.id, connection]));
  const reporting = [...new Set(live.map(object => object.connectionId))].map(id => connectionById.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const silent = connections.filter(connection => connection.status !== 'deleted' && !reporting.includes(connection)).sort((a, b) => a.name.localeCompare(b.name));
  return { objects: live, byId, children, roots, vmsOf, connectionById, reporting, silent, placed };
}

const byName = (a, b) => a.name.localeCompare(b.name);
export const vmsOn = (index, object) => (index.vmsOf.get(object.id) ?? []).slice().sort(byName);

// VMs on everything under an object (a cluster's hosts, a datacenter's hosts), counted once each.
export function vmCountUnder(index, object) {
  const seen = new Set(), walk = node => {
    if (node.kind === 'host') for (const vm of index.vmsOf.get(node.id) ?? []) seen.add(vm.id);
    for (const child of index.children.get(node.id) ?? []) walk(child);
  };
  walk(object);
  return seen.size;
}

const isDown = (index, connectionId) => DOWN.has(index.connectionById.get(connectionId)?.healthState);

// ---- the tree --------------------------------------------------------------------------------------------------------------------------------------------------

function nodeButton(index, object, selected, { esc }) {
  const count = object.kind === 'host' ? vmsOn(index, object).length : object.kind === 'datastore' || object.kind === 'network' ? vmsOn(index, object).length : vmCountUnder(index, object);
  const note = object.lifecycleState === 'missing' ? ' · missing' : '';
  const dot = object.kind === 'host' ? `<span class="infra-dot ${object.attributes.connectionState && object.attributes.connectionState !== 'connected' ? 'tone-bad' : 'tone-good'}" aria-hidden="true"></span>` : '';
  return `<button type="button" class="infra-node${object.id === selected ? ' is-selected' : ''}" data-infra-select="${esc(object.id)}"${object.id === selected ? ' aria-current="true"' : ''}><span class="infra-kind">${esc(KIND_LABELS[object.kind])}</span><span class="infra-name">${dot}${esc(object.name)}</span><small>${object.kind === 'datacenter' || object.kind === 'cluster' || object.kind === 'host' || object.kind === 'datastore' || object.kind === 'network' ? `${plural(count, 'VM')}${esc(note)}` : ''}</small></button>`;
}

function branch(index, objects, selected, ctx) {
  const groups = { datastore: [], network: [] }, rest = [];
  for (const object of objects.slice().sort(byName)) (groups[object.kind] ?? rest).push(object);
  const order = { datacenter: 0, cluster: 1, host: 2 };
  rest.sort((a, b) => order[a.kind] - order[b.kind] || byName(a, b));
  const items = rest.map(object => {
    const below = index.children.get(object.id) ?? [];
    return `<li>${nodeButton(index, object, selected, ctx)}${below.length ? branch(index, below, selected, ctx) : ''}</li>`;
  });
  for (const kind of ['datastore', 'network']) {
    if (groups[kind].length) items.push(`<li><p class="infra-group">${KIND_PLURALS[kind]} · ${groups[kind].length}</p><ul>${groups[kind].map(object => `<li>${nodeButton(index, object, selected, ctx)}</li>`).join('')}</ul></li>`);
  }
  return `<ul>${items.join('')}</ul>`;
}

export function treeHtml(index, selected, ctx) {
  const { esc, labelOf } = ctx;
  const silent = index.silent.length ? `<p class="infra-silent">Not reported by this kind of connection: ${index.silent.map(connection => esc(connection.name)).join(', ')}.</p>` : '';
  if (!index.objects.length) return `<div class="empty compact"><strong>No infrastructure reported yet</strong><p>Hosts, datastores and networks appear here once a VMware ESXi or vCenter connection has been discovered. VMware Workstation, AWS and Azure do not report them.</p></div>${silent}`;
  const connections = index.reporting.map(connection => {
    const down = DOWN.has(connection.healthState), id = `connection:${connection.id}`;
    return `<li><button type="button" class="infra-node infra-connection${id === selected ? ' is-selected' : ''}" data-infra-select="${esc(id)}"${id === selected ? ' aria-current="true"' : ''}><span class="infra-kind">${esc(labelOf(connection))}</span><span class="infra-name">${esc(connection.name)}</span><small>${down ? 'unreachable · last known' : ''}</small></button>${branch(index, index.roots.get(connection.id) ?? [], selected, ctx)}</li>`;
  });
  return `<ul class="infra-tree">${connections.join('')}</ul>${silent}`;
}

// ---- the panel for what is selected -----------------------------------------------------------------------------------------------------------------------------

function usageHtml(label, used, total, text, { esc }) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return '';
  const percent = Math.max(0, Math.min(100, Math.round(used / total * 100)));
  return `<div class="usage"><div class="usage-head"><span>${esc(label)}</span><strong>${esc(text)} · ${percent}%</strong></div><div class="usage-bar" role="img" aria-label="${esc(label)}: ${percent}% used"><span class="tone-${tone(percent)}" style="width:${percent}%"></span></div></div>`;
}

function factsHtml(rows, { esc }) {
  const shown = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
  return shown.length ? `<dl class="infra-facts">${shown.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>` : '';
}

function vmListHtml(vms, { esc, powerOf }, limit = 40) {
  if (!vms.length) return '<p class="infra-empty">No virtual machines.</p>';
  const shown = vms.slice(0, limit);
  return `<ul class="infra-vms">${shown.map(vm => `<li><button type="button" class="text-button" data-select-resource="${esc(vm.id)}">${esc(vm.name)}</button><small>${esc(powerOf(vm))}</small></li>`).join('')}</ul>${vms.length > limit ? `<p class="infra-empty">and ${vms.length - limit} more: search the inventory for the name of this object.</p>` : ''}`;
}

function linkListHtml(objects, { esc }) {
  return objects.length ? `<ul class="infra-links">${objects.map(object => `<li><button type="button" class="text-button" data-infra-select="${esc(object.id)}">${esc(object.name)}</button></li>`).join('')}</ul>` : '';
}

function header(object, ctx, subtitle) {
  const { esc } = ctx;
  return `<div class="card-head"><div><p class="eyebrow">${esc(KIND_LABELS[object.kind]?.toUpperCase() ?? 'CONNECTION')}</p><h2>${esc(object.name)}</h2>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</div></div>`;
}

export function detailHtml(index, selected, ctx) {
  const { esc, when, powerOf, labelOf } = ctx;
  if (!selected) return '<div class="empty compact"><strong>Select something in the tree</strong><p>Its details and the virtual machines on it appear here.</p></div>';
  if (selected.startsWith('connection:')) {
    const connection = index.connectionById.get(selected.slice('connection:'.length));
    if (!connection) return '<div class="empty compact"><p>That connection is no longer there.</p></div>';
    const mine = index.objects.filter(object => object.connectionId === connection.id), count = kind => mine.filter(object => object.kind === kind).length;
    return `<div class="card-head"><div><p class="eyebrow">CONNECTION</p><h2>${esc(connection.name)}</h2><small>${esc(labelOf(connection))}</small></div></div>${isDown(index, connection.id) ? '<p class="infra-warning" role="status">This connection cannot be reached; what is shown is what was last seen.</p>' : ''}${factsHtml([['Health', connection.healthState], ['Last sync', connection.lastSuccessAt ? when(connection.lastSuccessAt) : 'Never'], ['Datacenters', count('datacenter')], ['Clusters', count('cluster')], ['Hosts', count('host')], ['Datastores', count('datastore')], ['Networks', count('network')]], ctx)}`;
  }
  const object = index.byId.get(selected);
  if (!object) return '<div class="empty compact"><strong>That object is no longer reported</strong><p>Choose another in the tree.</p></div>';
  const connection = index.connectionById.get(object.connectionId), observed = object.lifecycleState === 'missing'
    ? `<p class="infra-warning" role="status">The provider no longer reports this ${esc(object.kind)} (last seen ${esc(when(object.lastSeenAt))}).</p>`
    : isDown(index, object.connectionId) ? '<p class="infra-warning" role="status">Its connection cannot be reached; this is what was last seen.</p>' : '';
  const a = object.attributes ?? {}, below = (index.children.get(object.id) ?? []).slice().sort(byName);
  const where = `${connection ? connection.name : ''}${object.lastSeenAt ? ` · seen ${when(object.lastSeenAt)}` : ''}`;
  if (object.kind === 'host') {
    const vms = vmsOn(index, object), datastores = new Map(), networks = new Map();
    for (const vm of vms) {
      for (const id of vm.providerMetadata?.placement?.datastoreNativeIds ?? []) { const found = index.objects.find(item => item.kind === 'datastore' && item.connectionId === object.connectionId && item.nativeId === id); if (found) datastores.set(found.id, found); }
      for (const id of vm.providerMetadata?.placement?.networkNativeIds ?? []) { const found = index.objects.find(item => item.kind === 'network' && item.connectionId === object.connectionId && item.nativeId === id); if (found) networks.set(found.id, found); }
    }
    const parent = object.parentNativeId ? index.objects.find(item => item.connectionId === object.connectionId && item.nativeId === object.parentNativeId && PARENT_KINDS.includes(item.kind)) : null;
    return `${header(object, ctx, where)}${observed}${factsHtml([['State', [a.connectionState, a.powerState].filter(Boolean).join(' · ')], ['Product', a.product], ['Version', a.version ? `${a.version}${a.build ? ` (build ${a.build})` : ''}` : undefined], ['Processor', a.cpuModel], ['Cores', a.cpuCores], ['Uptime', Number.isFinite(a.uptimeSeconds) ? formatUptime(a.uptimeSeconds) : undefined], [parent ? KIND_LABELS[parent.kind] : undefined, parent?.name]], ctx)}${usageHtml('CPU', a.cpuUsageMhz, a.cpuMhz, `${formatMhz(a.cpuUsageMhz)} of ${formatMhz(a.cpuMhz)}`, ctx)}${usageHtml('Memory', a.memoryUsageBytes, a.memoryBytes, `${formatBytes(a.memoryUsageBytes)} of ${formatBytes(a.memoryBytes)}`, ctx)}<h3>Virtual machines · ${vms.length}</h3>${vmListHtml(vms, ctx)}${datastores.size ? `<h3>Datastores used</h3>${linkListHtml([...datastores.values()].sort(byName), ctx)}` : ''}${networks.size ? `<h3>Networks used</h3>${linkListHtml([...networks.values()].sort(byName), ctx)}` : ''}`;
  }
  if (object.kind === 'datastore') {
    const vms = vmsOn(index, object), used = Number.isFinite(a.capacityBytes) && Number.isFinite(a.freeBytes) ? a.capacityBytes - a.freeBytes : undefined;
    return `${header(object, ctx, where)}${observed}${factsHtml([['Type', a.type], ['Accessible', a.accessible === undefined ? undefined : a.accessible ? 'Yes' : 'No'], ['Capacity', Number.isFinite(a.capacityBytes) ? formatBytes(a.capacityBytes) : undefined], ['Free', Number.isFinite(a.freeBytes) ? formatBytes(a.freeBytes) : undefined], ['URL', a.url]], ctx)}${usageHtml('Space used', used, a.capacityBytes, `${formatBytes(used)} of ${formatBytes(a.capacityBytes)}`, ctx)}<h3>Virtual machines · ${vms.length}</h3>${vmListHtml(vms, ctx)}`;
  }
  if (object.kind === 'network') {
    const vms = vmsOn(index, object);
    return `${header(object, ctx, where)}${observed}${factsHtml([['Type', a.type], ['Accessible', a.accessible === undefined ? undefined : a.accessible ? 'Yes' : 'No']], ctx)}<h3>Virtual machines · ${vms.length}</h3>${vmListHtml(vms, ctx)}`;
  }
  // a cluster or a datacenter
  const hosts = below.filter(item => item.kind === 'host'), vmTotal = vmCountUnder(index, object);
  return `${header(object, ctx, where)}${observed}${factsHtml([['Hosts', object.kind === 'cluster' ? (Number.isFinite(a.hostCount) ? a.hostCount : hosts.length) : undefined], ['Virtual machines', vmTotal], ['DRS', a.drsEnabled === undefined ? undefined : a.drsEnabled ? 'On' : 'Off'], ['HA', a.haEnabled === undefined ? undefined : a.haEnabled ? 'On' : 'Off']], ctx)}${below.length ? `<h3>Contains</h3>${linkListHtml(below, ctx)}` : ''}`;
}

// ---- where a virtual machine runs ----------------------------------------------------------------------------------------------------------------------------

// Rows for the VM's detail: [{ label, objects: [{ id, name }] }], empty when the provider said nothing about where it runs.
export function placementRows(vm, index) {
  const placement = vm.providerMetadata?.placement;
  if (!placement) return [];
  const find = (kind, id) => index.objects.find(object => object.connectionId === vm.connectionId && object.kind === kind && object.nativeId === id);
  const host = find('host', placement.hostNativeId), datastores = (placement.datastoreNativeIds ?? []).map(id => find('datastore', id)).filter(Boolean), networks = (placement.networkNativeIds ?? []).map(id => find('network', id)).filter(Boolean);
  return [host ? { label: 'Host', objects: [host] } : null, datastores.length ? { label: 'Datastores', objects: datastores } : null, networks.length ? { label: 'Networks', objects: networks } : null].filter(Boolean);
}

export function placementRowsHtml(vm, index, { esc }) {
  return placementRows(vm, index).map(row => `<dt>${esc(row.label)}</dt><dd>${row.objects.map(object => `<button type="button" class="text-button" data-infra-open="${esc(object.id)}">${esc(object.name)}</button>`).join(', ')}</dd>`).join('');
}

// The one-line version for the top of a VM's detail: the host it runs on, when the provider said and the host is known.
export function hostFactHtml(vm, index, { esc }) {
  const host = placementRows(vm, index).find(row => row.label === 'Host')?.objects[0];
  return host ? `<dt>Runs on</dt><dd><button type="button" class="text-button" data-infra-open="${esc(host.id)}">${esc(host.name)}</button></dd>` : '';
}

// Words that find a VM by where it runs (its host, datastores and networks), for the inventory search.
export const placementSearchText = (vm, index) => placementRows(vm, index).flatMap(row => row.objects.map(object => object.name)).join(' ');
