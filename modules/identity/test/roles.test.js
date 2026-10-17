import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleError, PERMISSIONS, PERMISSION_KEYS, SYSTEM_ROLES, IMPLIES, normaliseRoleName, normaliseDescription, normalisePermissions, parseRoleRequest, permissionsBeyond, roleDisplayName } from '../src/roles.js';

// What a custom role may look like. The same functions judge a request in both stores and in the API, so these rules are the rules.
const refused = (work, code) => assert.throws(work, error => (code ? error.code === code : error instanceof RoleError), String(work).slice(0, 60));

test('every permission is documented, and the built-in roles use only permissions that exist', () => {
  assert.ok(PERMISSIONS.every(permission => permission.key && permission.group && permission.description.length > 20));
  assert.equal(new Set(PERMISSION_KEYS).size, PERMISSION_KEYS.length);
  for (const [name, role] of Object.entries(SYSTEM_ROLES)) assert.ok(role.permissions.every(key => PERMISSION_KEYS.includes(key)), name);
  assert.deepEqual([...SYSTEM_ROLES.platform_admin.permissions].sort(), [...PERMISSION_KEYS].sort(), 'the administrator role holds every permission');
});

test('the built-in roles satisfy the same dependency rule as a custom one', () => {
  for (const [name, role] of Object.entries(SYSTEM_ROLES)) assert.doesNotThrow(() => normalisePermissions(role.permissions), name);
  for (const [key, needed] of Object.entries(IMPLIES)) assert.ok(PERMISSION_KEYS.includes(key) && needed.every(other => PERMISSION_KEYS.includes(other)), key);
});

test('a role name is lower case with underscores for spaces; the built-in names, bad characters and bad lengths are refused', () => {
  assert.equal(normaliseRoleName('  Tag Keeper '), 'tag_keeper');
  assert.equal(normaliseRoleName('night-shift_2'), 'night-shift_2');
  for (const bad of [undefined, null, '', 'a', 'x'.repeat(41), '1abc', '-abc', 'a/b', 'a.b', 'ünï', 'a\u0000b', 5]) refused(() => normaliseRoleName(bad));
  for (const reserved of ['platform_admin', 'Platform Admin', 'OPERATOR', 'auditor']) refused(() => normaliseRoleName(reserved), 'NUV_ROLE_RESERVED');
  assert.equal(roleDisplayName('tag_keeper'), 'tag keeper');
});

test('a description is trimmed, bounded and free of control characters', () => {
  assert.equal(normaliseDescription('  ok '), 'ok');
  assert.equal(normaliseDescription(undefined), '');
  refused(() => normaliseDescription('x'.repeat(201)));
  for (const bad of ['a\nb', 'a\u0007b', 'a‮b', 'a​b']) refused(() => normaliseDescription(bad));
});

test('permissions must be known, at least one, and complete: each one needs what it depends on; the order is the catalogue’s and repeats collapse', () => {
  assert.deepEqual(normalisePermissions(['resource.tag', 'resource.view', 'resource.tag']), ['resource.view', 'resource.tag']);
  for (const bad of [undefined, 'resource.view', [], ['nope'], [1], [null], ['resource.view', '__proto__'], ['resource.operate'], ['resource.view', 'connection.manage'], ['identity.manage']]) refused(() => normalisePermissions(bad));
  refused(() => normalisePermissions(['resource.operate']), 'NUV_ROLE_PERMISSION_DEPENDENCY');
});

test('a request must be an object with only the known fields; a change does not take a name', () => {
  assert.deepEqual(parseRoleRequest({ name: 'Ops Lead', description: ' d ', permissions: ['resource.view'] }), { name: 'ops_lead', description: 'd', permissions: ['resource.view'] });
  assert.deepEqual(parseRoleRequest({ permissions: ['resource.view'] }, { name: false }), { description: '', permissions: ['resource.view'] });
  for (const bad of [null, [], 'x', 5, { name: 'ab', permissions: ['resource.view'], extra: 1 }]) refused(() => parseRoleRequest(bad));
  refused(() => parseRoleRequest({ name: 'ab', permissions: ['resource.view'] }, { name: false }), 'NUV_ROLE_INVALID');
});

test('permissionsBeyond lists what is wanted but not held', () => {
  assert.deepEqual(permissionsBeyond(['resource.view'], ['resource.view', 'resource.operate']), ['resource.operate']);
  assert.deepEqual(permissionsBeyond(PERMISSION_KEYS, PERMISSION_KEYS), []);
  assert.deepEqual(permissionsBeyond([], []), []);
});
