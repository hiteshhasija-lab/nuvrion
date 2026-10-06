// Compares two versions of an OpenAPI description and reports changes that would break an existing client.
// A client sends requests and reads responses, so the rules differ by direction:
//   request  (what a client sends):   breaking when the API asks for MORE (a new required field, a narrower type, fewer allowed values, a tighter limit)
//   response (what a client reads):   breaking when the API promises LESS (a removed or retyped field, a field no longer guaranteed, a new enum value to handle)
// Additions that only give clients more (new operations, new optional request fields, new response fields) are reported but never block.
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const typesOf = schema => new Set([].concat(schema?.type ?? []));
const keyOf = (method, path) => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, '{}')}`;     // a renamed path parameter is not a change on the wire

function resolver(spec) {
  const resolve = (node, trail = []) => {
    if (Array.isArray(node)) return node.map(item => resolve(item, trail));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      if (trail.includes(node.$ref)) return { 'x-recursive': node.$ref };
      const target = node.$ref.slice(2).split('/').reduce((current, part) => current?.[part], spec);
      return resolve(target, [...trail, node.$ref]);
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value, trail)]));
  };
  return resolve;
}

// allOf is flattened so that "base + extras" compares the same as one merged object.
function flatten(schema) {
  if (!schema?.allOf) return schema;
  const merged = { ...schema }; delete merged.allOf;
  for (const part of schema.allOf.map(flatten)) {
    for (const [key, value] of Object.entries(part ?? {})) {
      if (key === 'properties') merged.properties = { ...merged.properties, ...value };
      else if (key === 'required') merged.required = [...new Set([...(merged.required ?? []), ...value])];
      else if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

function diffSchema(before, after, direction, where, report) {
  before = flatten(before); after = flatten(after);
  if (before === undefined || after === undefined) return;
  if (before?.['x-recursive'] || after?.['x-recursive']) return;
  const breaking = reason => report.breaking.push({ where, reason });

  for (const keyword of ['oneOf', 'anyOf']) {
    if (before[keyword] || after[keyword]) {
      if (JSON.stringify(before[keyword]) !== JSON.stringify(after[keyword])) breaking(`${keyword} alternatives changed`);
      return;
    }
  }
  const was = typesOf(before), now = typesOf(after);
  if (was.size && now.size) {
    const gained = [...now].filter(type => !was.has(type) && !(type === 'number' && was.has('integer')) ), lost = [...was].filter(type => !now.has(type) && !(type === 'integer' && now.has('number')));
    if (direction === 'response' && gained.length) breaking(`type widened: now may also be ${gained.join(', ')}`);
    if (direction === 'request' && lost.length) breaking(`type narrowed: no longer accepts ${lost.join(', ')}`);
  } else if (was.size && !now.size && direction === 'request') { /* a constraint was dropped: accepts more */ }
  else if (!was.size && now.size && direction === 'request') breaking(`now requires type ${[...now].join(', ')}`);

  if (before.enum || after.enum) {
    const old = new Set((before.enum ?? []).map(String)), next = new Set((after.enum ?? []).map(String));
    if (direction === 'response') { const added = [...next].filter(value => before.enum && !old.has(value)); if (added.length) breaking(`new value(s) a client must handle: ${added.join(', ')}`); }
    else { const removed = [...old].filter(value => after.enum && !next.has(value)); if (removed.length) breaking(`no longer accepts: ${removed.join(', ')}`); if (!before.enum && after.enum) breaking('now restricted to a fixed set of values'); }
  }
  if ('const' in before && JSON.stringify(before.const) !== JSON.stringify(after.const)) breaking('constant value changed');

  if (direction === 'request') {
    for (const [keyword, tighter] of [['minimum', (a, b) => b > a], ['minLength', (a, b) => b > a], ['minItems', (a, b) => b > a], ['maximum', (a, b) => b < a], ['maxLength', (a, b) => b < a], ['maxItems', (a, b) => b < a]]) {
      if (after[keyword] !== undefined && (before[keyword] === undefined || tighter(before[keyword], after[keyword]))) breaking(`${keyword} is now ${after[keyword]}${before[keyword] === undefined ? '' : ` (was ${before[keyword]})`}`);
    }
    if (after.pattern !== undefined && after.pattern !== before.pattern) breaking('pattern changed or added');
  }

  const oldRequired = new Set(before.required ?? []), newRequired = new Set(after.required ?? []);
  for (const [name, schema] of Object.entries(before.properties ?? {})) {
    if (!(name in (after.properties ?? {}))) {
      if (direction === 'response') breaking(`property "${name}" was removed`);
      continue;
    }
    if (direction === 'response' && oldRequired.has(name) && !newRequired.has(name)) breaking(`property "${name}" is no longer guaranteed`);
    diffSchema(schema, after.properties[name], direction, `${where}.${name}`, report);
  }
  for (const name of Object.keys(after.properties ?? {})) {
    if (!(name in (before.properties ?? {}))) {
      if (direction === 'request' && newRequired.has(name)) breaking(`new required property "${name}"`);
      else report.additions.push({ where: `${where}.${name}`, what: `new ${direction} property` });
    }
  }
  if (direction === 'request') for (const name of newRequired) if (!oldRequired.has(name) && name in (before.properties ?? {})) breaking(`property "${name}" is now required`);
  if (before.items || after.items) diffSchema(before.items, after.items, direction, `${where}[]`, report);
}

export function compareOpenApi(beforeSpec, afterSpec) {
  const report = { breaking: [], additions: [], notes: [] };
  const before = resolver(beforeSpec)(beforeSpec.paths ?? {}), after = resolver(afterSpec)(afterSpec.paths ?? {});
  const index = paths => new Map(Object.entries(paths).flatMap(([path, item]) => METHODS.filter(method => item[method]).map(method => [keyOf(method, path), { path, method, op: item[method], item }])));
  const was = index(before), now = index(after);

  for (const [key, old] of was) {
    const next = now.get(key);
    if (!next) { report.breaking.push({ where: key, reason: 'operation was removed' }); continue; }
    const at = text => `${key} ${text}`;
    if (old.op.operationId && old.op.operationId !== next.op.operationId) report.breaking.push({ where: key, reason: `operationId changed from ${old.op.operationId} to ${next.op.operationId} (generated clients use it)` });

    // security: more access control than before breaks callers that relied on the old rules. Rules the old description never stated are
    // documentation being added, not a change to the API, so they are not compared.
    if (old.op.security !== undefined || beforeSpec.security !== undefined) {
      const oldSecurity = JSON.stringify(old.op.security ?? beforeSpec.security), newSecurity = JSON.stringify(next.op.security ?? afterSpec.security ?? []);
      if (oldSecurity === '[]' && newSecurity !== '[]') report.breaking.push({ where: key, reason: 'now requires authentication' });
      else if (oldSecurity !== newSecurity) report.breaking.push({ where: key, reason: `authentication changed from ${oldSecurity} to ${newSecurity}` });
    }
    const oldPermission = old.op['x-required-permission'];
    if (oldPermission !== undefined && next.op['x-required-permission'] !== undefined && oldPermission !== next.op['x-required-permission']) report.breaking.push({ where: key, reason: `required permission changed from ${oldPermission} to ${next.op['x-required-permission']}` });

    // parameters
    const params = operation => new Map([...(operation.item.parameters ?? []), ...(operation.op.parameters ?? [])].map(p => [`${p.in}:${p.name.toLowerCase()}`, p]));
    const oldParams = params(old), newParams = params(next);
    for (const [id, parameter] of newParams) {
      if (!oldParams.has(id)) { if (parameter.required) report.breaking.push({ where: at(`parameter ${id}`), reason: 'new required parameter' }); else report.additions.push({ where: at(`parameter ${id}`), what: 'new optional parameter' }); }
      else {
        if (parameter.required && !oldParams.get(id).required) report.breaking.push({ where: at(`parameter ${id}`), reason: 'parameter is now required' });
        diffSchema(oldParams.get(id).schema, parameter.schema, 'request', at(`parameter ${id}`), report);
      }
    }

    // request body
    if (old.op.requestBody && !old.op.requestBody.required && next.op.requestBody?.required) report.breaking.push({ where: at('request body'), reason: 'a request body is now required' });
    for (const [media, content] of Object.entries(old.op.requestBody?.content ?? {})) {
      if (!next.op.requestBody?.content?.[media]) report.breaking.push({ where: at('request body'), reason: `no longer accepts ${media}` });
      else diffSchema(content.schema, next.op.requestBody.content[media].schema, 'request', at(`request ${media}`), report);
    }

    // responses
    for (const [status, response] of Object.entries(old.op.responses ?? {})) {
      const replacement = next.op.responses?.[status];
      if (!replacement) { (status.startsWith('2') ? report.breaking : report.notes).push({ where: at(`response ${status}`), reason: 'status is no longer documented' }); continue; }
      for (const [media, content] of Object.entries(response.content ?? {})) {
        if (!replacement.content?.[media]) report.breaking.push({ where: at(`response ${status}`), reason: `no longer returns ${media}` });
        else diffSchema(content.schema, replacement.content[media].schema, 'response', at(`response ${status} ${media}`), report);
      }
      for (const header of Object.keys(response.headers ?? {})) if (!replacement.headers?.[header]) report.breaking.push({ where: at(`response ${status}`), reason: `header ${header} is no longer returned` });
    }
    for (const status of Object.keys(next.op.responses ?? {})) if (!old.op.responses?.[status]) report.additions.push({ where: at(`response ${status}`), what: 'new response status' });
  }
  for (const key of now.keys()) if (!was.has(key)) report.additions.push({ where: key, what: 'new operation' });
  return report;
}
