// What the platform keeps about the infrastructure a provider reports besides virtual machines: datacenters, clusters, hosts, datastores and networks (docs/infrastructure.md).
//
// A provider describes these objects in its own words; this module turns what it says into a small, fixed, provider-neutral shape and drops everything else. What a provider
// sends is not trusted: kinds are a closed list, strings are bounded and free of control characters, numbers must be real non-negative integers, unknown attributes are
// dropped, and one report may not hold more than MAX_OBJECTS objects or the same object twice.

export const KINDS = Object.freeze(['datacenter', 'cluster', 'host', 'datastore', 'network']);
export const MAX_OBJECTS = 5000;
const text = max => value => {
  if (typeof value !== 'string' || value.length > 4 * max) return undefined;   // a string far over the limit is dropped, not cut down into something that looks plausible
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, max);
  return clean || undefined;
};
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const flag = value => (typeof value === 'boolean' ? value : undefined);

// Per kind, the attributes that are kept and how each is cleaned.
export const ATTRIBUTES = Object.freeze({
  datacenter: {},
  cluster: { hostCount: count, drsEnabled: flag, haEnabled: flag },
  host: { powerState: text(32), connectionState: text(32), product: text(128), version: text(32), build: text(32), cpuModel: text(128), cpuCores: count, cpuMhz: count,
    memoryBytes: count, cpuUsageMhz: count, memoryUsageBytes: count, uptimeSeconds: count },
  datastore: { type: text(32), capacityBytes: count, freeBytes: count, accessible: flag, url: text(256) },
  network: { type: text(32), accessible: flag }
});

export class InfrastructureError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function normaliseObject(item) {
  if (!item || typeof item !== 'object' || !KINDS.includes(item.kind)) throw new InfrastructureError('NUV_INFRASTRUCTURE_INVALID', `Unknown infrastructure kind: ${String(item?.kind).slice(0, 40)}.`);
  const nativeId = text(256)(item.nativeId), name = text(256)(item.name);
  if (!nativeId) throw new InfrastructureError('NUV_INFRASTRUCTURE_INVALID', `A ${item.kind} was reported without an identifier.`);
  const attributes = {};
  for (const [key, clean] of Object.entries(ATTRIBUTES[item.kind])) {
    const value = clean(item.attributes?.[key]);
    if (value !== undefined) attributes[key] = value;
  }
  return { kind: item.kind, nativeId, name: name ?? nativeId, parentNativeId: text(256)(item.parentNativeId) ?? null, attributes };
}

// A whole report: every object cleaned, none twice, not too many.
export function normaliseReport(items) {
  if (!Array.isArray(items)) throw new InfrastructureError('NUV_INFRASTRUCTURE_INVALID', 'The infrastructure report must be a list.');
  if (items.length > MAX_OBJECTS) throw new InfrastructureError('NUV_INFRASTRUCTURE_TOO_LARGE', `The provider reported ${items.length} infrastructure objects; the limit is ${MAX_OBJECTS}.`);
  const seen = new Set(), result = [];
  for (const item of items) {
    const object = normaliseObject(item), key = `${object.kind}:${object.nativeId}`;
    if (seen.has(key)) throw new InfrastructureError('NUV_INFRASTRUCTURE_INVALID', `The ${object.kind} ${object.nativeId} was reported twice.`);
    seen.add(key); result.push(object);
  }
  return result;
}
