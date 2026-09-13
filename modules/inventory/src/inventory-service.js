import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {evaluateCapabilities,capabilityFor} from './resource-capabilities.js';
import {retainLastPoweredOnGuestMetadata} from './guest-metadata-retention.js';

const clone = value => structuredClone(value);
export class InventoryService {
  #resources = new Map(); #file;
  constructor({ file = null } = {}) {
    this.#file = file;
    if (file && existsSync(file)) {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      this.#resources = new Map(state.resources ?? []);
    }
  }
  #persist() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, resources: [...this.#resources] }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.#file);
  }
  synchronize(connection, observations) {
    const observedAt = new Date().toISOString();
    const seen = new Set(); let created = 0; let updated = 0;
    for (const item of observations) {
      const key = `${connection.id}:${item.resourceType}:${item.nativeId}`;
      if (seen.has(key)) throw new Error('DUPLICATE_PROVIDER_IDENTITY');
      seen.add(key);
      const prior = this.#resources.get(key);
      const metadata = retainLastPoweredOnGuestMetadata(prior,item);
      const resource = {
        id: prior?.id ?? randomUUID(), connectionId: connection.id, providerType: connection.providerType,
        resourceType: item.resourceType, nativeId: item.nativeId, name: item.name,
        lifecycleState: 'active', healthState: item.healthState ?? 'unknown', observedAt,
        firstSeenAt: prior?.firstSeenAt ?? observedAt, lastSeenAt: observedAt, missingSince: null,
        version: (prior?.version ?? 0) + 1,
        attributes: clone(item.attributes ?? {}), providerMetadata: clone(metadata),
        providerMetadataHash: createHash('sha256').update(JSON.stringify(metadata)).digest('hex')
      };
      this.#resources.set(key, resource); prior ? updated++ : created++;
    }
    let missing = 0;
    for (const [key, resource] of this.#resources) {
      if (resource.connectionId === connection.id && !seen.has(key) && resource.lifecycleState !== 'missing') {
        resource.lifecycleState = 'missing'; resource.missingSince = observedAt; resource.version++; missing++;
      }
    }
    this.#persist();
    return { connectionId: connection.id, observedAt, discovered: observations.length, created, updated, missing };
  }
  list({ connectionId, resourceType, lifecycleState, search } = {}) {
    const term = search?.trim().toLowerCase();
    return [...this.#resources.values()].filter(resource =>
      (!connectionId || resource.connectionId === connectionId) &&
      (!resourceType || resource.resourceType === resourceType) &&
      (!lifecycleState || resource.lifecycleState === lifecycleState) &&
      (!term || resource.name.toLowerCase().includes(term) || resource.nativeId.toLowerCase().includes(term))
    ).sort((a,b) => a.name.localeCompare(b.name)).map(resource=>({...clone(resource),capabilities:evaluateCapabilities(resource)}));
  }
  get(id) { const resource = [...this.#resources.values()].find(item => item.id === id); return resource ? {...clone(resource),capabilities:evaluateCapabilities(resource)} : null; }
  retireConnection(connectionId){const now=new Date().toISOString();let retired=0;for(const resource of this.#resources.values()){if(resource.connectionId!==connectionId||resource.lifecycleState==='deleted')continue;resource.lifecycleState='deleted';resource.missingSince=resource.missingSince??now;resource.version++;retired++;}this.#persist();return retired;}
  validateOperation(id, operation) {
    const resource=this.get(id); if(!resource)return {ok:false,code:'NUV_RESOURCE_NOT_FOUND'};
    if(resource.lifecycleState!=='active')return {ok:false,code:'NUV_RESOURCE_UNAVAILABLE'};
    if(resource.resourceType!=='virtual_machine')return {ok:false,code:'NUV_OPERATION_UNSUPPORTED'};
    const capability=capabilityFor(resource,operation);if(!capability)return {ok:false,code:'NUV_OPERATION_INVALID'};
    if(!capability.enabled)return {ok:false,code:'NUV_OPERATION_STATE_CONFLICT',detail:capability.reason};
    return {ok:true,resource};
  }
  applyOperation(id, operation, result) {
    const entry=[...this.#resources.entries()].find(([,resource])=>resource.id===id);if(!entry)return null;
    const [key,resource]=entry;resource.attributes.powerState=result.observedFinalState;resource.observedAt=new Date().toISOString();resource.lastSeenAt=resource.observedAt;resource.version++;resource.lastOperation={operation,completedAt:resource.observedAt,resultCode:result.code};this.#resources.set(key,resource);this.#persist();return clone(resource);
  }
  metrics() { const values = [...this.#resources.values()]; return { resourcesTotal: values.length, resourcesActive: values.filter(x => x.lifecycleState === 'active').length, resourcesMissing: values.filter(x => x.lifecycleState === 'missing').length }; }
}
