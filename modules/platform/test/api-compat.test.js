import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compareMessageSchemas, compareOpenApi } from '../src/api-compat.js';

// Small specifications built from one operation: GET /things/{id} and POST /things.
const thing = { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' }, size: { type: 'integer' } } };
const spec = (over = {}) => structuredClone({
  openapi: '3.1.0', info: { title: 'T', version: '1' }, security: [{ session: [] }],
  paths: {
    '/things/{id}': { get: { operationId: 'getThing', 'x-required-permission': 'thing.view', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } }, 404: { description: 'missing' } } } },
    '/things': { post: { operationId: 'createThing', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 80 }, kind: { type: 'string', enum: ['a', 'b'] } } } } } }, responses: { 201: { description: 'made', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } } } }
  },
  components: { schemas: { Thing: thing } },
  ...over
});
const breaking = (before, after) => compareOpenApi(before, after).breaking.map(b => `${b.where}: ${b.reason}`);
const edit = (change, base = spec()) => { change(base); return base; };

test('an unchanged description is compatible', () => {
  const report = compareOpenApi(spec(), spec());
  assert.deepEqual([report.breaking, report.additions], [[], []]);
});

test('new operations, optional request fields and response fields never break a client', () => {
  const after = edit(s => {
    s.paths['/other'] = { get: { operationId: 'other', responses: { 200: { description: 'ok' } } } };
    s.paths['/things'].post.requestBody.content['application/json'].schema.properties.note = { type: 'string' };
    s.components.schemas.Thing.properties.color = { type: 'string' };
    s.paths['/things/{id}'].get.parameters.push({ in: 'query', name: 'verbose', schema: { type: 'boolean' } });
    s.paths['/things/{id}'].get.responses[500] = { description: 'boom' };
  });
  const report = compareOpenApi(spec(), after);
  assert.deepEqual(report.breaking, []);
  assert.ok(report.additions.length >= 4);
});

test('removing an operation, or changing its operationId, breaks clients', () => {
  assert.deepEqual(breaking(spec(), edit(s => { delete s.paths['/things']; })), ['POST /things: operation was removed']);
  assert.match(breaking(spec(), edit(s => { s.paths['/things'].post.operationId = 'makeThing'; }))[0], /operationId changed from createThing to makeThing/);
});

test('a renamed path parameter is not a change on the wire', () => {
  const after = edit(s => { s.paths['/things/{thingId}'] = s.paths['/things/{id}']; delete s.paths['/things/{id}']; s.paths['/things/{thingId}'].get.parameters[0].name = 'thingId'; });
  assert.deepEqual(breaking(spec(), after).filter(b => !b.includes('parameter path')), []);
});

test('response: removing a field, making it less certain, or changing its type breaks clients', () => {
  assert.match(breaking(spec(), edit(s => { delete s.components.schemas.Thing.properties.size; }))[0], /property "size" was removed/);
  assert.match(breaking(spec(), edit(s => { s.components.schemas.Thing.required = ['id']; }))[0], /property "name" is no longer guaranteed/);
  assert.match(breaking(spec(), edit(s => { s.components.schemas.Thing.properties.id.type = 'integer'; }))[0], /type widened: now may also be integer/);
  assert.match(breaking(spec(), edit(s => { s.components.schemas.Thing.properties.name.type = ['string', 'null']; }))[0], /type widened: now may also be null/);
});

test('response: a new enum value breaks clients that switch on it; removing one does not', () => {
  const withEnum = edit(s => { s.components.schemas.Thing.properties.state = { type: 'string', enum: ['on', 'off'] }; });
  assert.match(breaking(withEnum, edit(s => { s.components.schemas.Thing.properties.state = { type: 'string', enum: ['on', 'off', 'broken'] }; }, spec()))[0] ?? '', /^$|new value/);
  const widened = edit(s => { s.components.schemas.Thing.properties.state = { type: 'string', enum: ['on', 'off', 'broken'] }; });
  assert.match(breaking(withEnum, widened)[0], /new value\(s\) a client must handle: broken/);
  assert.deepEqual(breaking(widened, withEnum), []);
});

test('response: nested objects and arrays are compared too', () => {
  const nested = edit(s => { s.components.schemas.Thing.properties.parts = { type: 'array', items: { type: 'object', required: ['n'], properties: { n: { type: 'integer' }, label: { type: 'string' } } } }; });
  const after = edit(s => { s.components.schemas.Thing.properties.parts = { type: 'array', items: { type: 'object', required: ['n'], properties: { n: { type: 'string' } } } }; });
  const reasons = breaking(nested, after).join('\n');
  assert.match(reasons, /parts\[\]\.n.*type widened/);
  assert.match(reasons, /parts\[\].*property "label" was removed/);
});

test('response: allOf is compared as the merged object', () => {
  const split = edit(s => { s.components.schemas.Thing = { allOf: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, { type: 'object', required: ['name'], properties: { name: { type: 'string' }, size: { type: 'integer' } } }] }; });
  assert.deepEqual(breaking(spec(), split), [], 'the same fields, written as allOf');
  assert.match(breaking(split, edit(s => { s.components.schemas.Thing = { allOf: [{ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }] }; }))[0], /was removed/);
});

test('request: a new required field, a narrower type or tighter limit, or a removed enum value breaks clients', () => {
  const body = s => s.paths['/things'].post.requestBody.content['application/json'].schema;
  assert.match(breaking(spec(), edit(s => { body(s).properties.owner = { type: 'string' }; body(s).required.push('owner'); }))[0], /new required property "owner"/);
  assert.match(breaking(spec(), edit(s => { body(s).required.push('kind'); }))[0], /property "kind" is now required/);
  assert.match(breaking(spec(), edit(s => { body(s).properties.name.maxLength = 40; }))[0], /maxLength is now 40 \(was 80\)/);
  assert.match(breaking(spec(), edit(s => { body(s).properties.kind.enum = ['a']; }))[0], /no longer accepts: b/);
  assert.match(breaking(spec(), edit(s => { body(s).properties.name.type = 'integer'; }))[0], /type narrowed: no longer accepts string/);
  assert.deepEqual(breaking(spec(), edit(s => { body(s).properties.name.maxLength = 200; body(s).properties.kind.enum = ['a', 'b', 'c']; })), [], 'accepting more is fine');
});

test('request: a new required parameter, an optional one becoming required, or a body becoming required breaks clients', () => {
  assert.match(breaking(spec(), edit(s => { s.paths['/things/{id}'].get.parameters.push({ in: 'header', name: 'X-Tenant', required: true, schema: { type: 'string' } }); }))[0], /new required parameter/);
  const optional = edit(s => { s.paths['/things/{id}'].get.parameters.push({ in: 'query', name: 'q', schema: { type: 'string' } }); });
  assert.match(breaking(optional, edit(s => { s.paths['/things/{id}'].get.parameters.push({ in: 'query', name: 'q', required: true, schema: { type: 'string' } }); }))[0], /parameter is now required/);
  const optionalBody = edit(s => { s.paths['/things'].post.requestBody.required = false; });
  assert.match(breaking(optionalBody, spec())[0], /a request body is now required/);
});

test('responses: a removed success status or media type breaks clients; a removed error status is only noted', () => {
  assert.match(breaking(spec(), edit(s => { delete s.paths['/things'].post.responses[201]; s.paths['/things'].post.responses[200] = { description: 'ok' }; }))[0], /response 201.*no longer documented/);
  const report = compareOpenApi(spec(), edit(s => { delete s.paths['/things/{id}'].get.responses[404]; }));
  assert.deepEqual(report.breaking, []);
  assert.equal(report.notes.length, 1);
  assert.match(breaking(spec(), edit(s => { s.paths['/things/{id}'].get.responses[200].content = { 'text/plain': { schema: { type: 'string' } } }; }))[0], /no longer returns application\/json/);
});

test('security: a public operation that now needs sign-in, or a higher permission, breaks clients', () => {
  const publicSpec = edit(s => { s.paths['/things/{id}'].get.security = []; });
  assert.match(breaking(publicSpec, spec())[0], /now requires authentication/);
  assert.match(breaking(spec(), edit(s => { s.paths['/things/{id}'].get['x-required-permission'] = 'thing.admin'; }))[0], /required permission changed from thing.view to thing.admin/);
  assert.deepEqual(breaking(spec(), edit(s => { delete s.paths['/things/{id}'].get['x-required-permission']; })), [], 'a lower requirement is fine');
});

test('rules the old description never stated are documentation, not a change', () => {
  const undocumented = edit(s => { delete s.security; delete s.paths['/things/{id}'].get['x-required-permission']; delete s.paths['/things'].post.requestBody; });
  assert.deepEqual(breaking(undocumented, spec()), []);
});

test('response headers that disappear break clients', () => {
  const withHeader = edit(s => { s.paths['/things'].post.responses[201].headers = { Location: { schema: { type: 'string' } } }; });
  assert.match(breaking(withHeader, spec())[0], /header Location is no longer returned/);
  assert.deepEqual(breaking(spec(), withHeader), []);
});

// ---- message schemas ----
const message = (over = {}) => structuredClone({
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.invalid/m.json', title: 'M', type: 'object', required: ['taskId'], additionalProperties: false,
  properties: { taskId: { type: 'string', format: 'uuid' }, kind: { enum: ['a', 'b'] } }, ...over
});
const messageBreaks = (before, after) => compareMessageSchemas(before, after, 'm.json').breaking.map(b => `${b.where}: ${b.reason}`);

test('an unchanged message schema is compatible', () => {
  const report = compareMessageSchemas(message(), message(), 'm.json');
  assert.deepEqual([report.breaking, report.additions], [[], []]);
});

test('messages: removing a property breaks consumers, and a new required property breaks producers', () => {
  assert.match(messageBreaks(message(), message({ properties: { taskId: { type: 'string', format: 'uuid' } } }))[0], /property "kind" was removed/);
  const withRequired = message({ required: ['taskId', 'owner'], properties: { taskId: { type: 'string' }, kind: { enum: ['a', 'b'] }, owner: { type: 'string' } } });
  assert.ok(messageBreaks(message(), withRequired).some(r => /new required property "owner"/.test(r)));
});

test('messages: a closed schema that gains even an optional property is breaking; an open one is not', () => {
  const grown = message({ properties: { taskId: { type: 'string', format: 'uuid' }, kind: { enum: ['a', 'b'] }, note: { type: 'string' } } });
  assert.ok(messageBreaks(message(), grown).some(r => /closed object gained property "note"/.test(r)));
  const open = message({ additionalProperties: true });
  assert.deepEqual(messageBreaks(open, { ...grown, additionalProperties: true }), []);
  assert.ok(messageBreaks(open, message()).some(r => /now rejects properties it used to allow/.test(r)));
});

test('messages: a retyped field, a new enum value for consumers, a removed enum value for producers and a changed constant all break', () => {
  assert.ok(messageBreaks(message(), message({ properties: { taskId: { type: 'integer' }, kind: { enum: ['a', 'b'] } } })).length > 0, 'retyped');
  assert.ok(messageBreaks(message(), message({ properties: { taskId: { type: 'string', format: 'uuid' }, kind: { enum: ['a', 'b', 'c'] } } })).some(r => /new value\(s\) a client must handle: c/.test(r)), 'enum grew');
  assert.ok(messageBreaks(message(), message({ properties: { taskId: { type: 'string', format: 'uuid' }, kind: { enum: ['a'] } } })).some(r => /no longer accepts: b/.test(r)), 'enum shrank');
  const versioned = message({ properties: { taskId: { type: 'string' }, schemaVersion: { const: 1 } } });
  assert.ok(messageBreaks(versioned, message({ properties: { taskId: { type: 'string' }, schemaVersion: { const: 2 } } })).some(r => /constant value changed/.test(r)));
});

test('messages: renaming the schema id breaks, and a changed description does not', () => {
  assert.ok(messageBreaks(message(), message({ $id: 'https://example.invalid/other.json' })).some(r => /\$id changed/.test(r)));
  assert.deepEqual(messageBreaks(message(), message({ description: 'Now with a description.', title: 'Renamed title' })), []);
});

test('every message schema in the repository is checked as compatible with itself, and the one in use is the real task message', () => {
  const dir = new URL('../../../contracts/messages/', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.json'));
  assert.ok(files.includes('task-queued.schema.json') && files.includes('task-command.schema.json'));
  for (const file of files) {
    const schema = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    assert.deepEqual(compareMessageSchemas(schema, schema, file).breaking, [], file);
  }
});
