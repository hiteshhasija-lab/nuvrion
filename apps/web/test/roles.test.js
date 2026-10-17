import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS } from '../../../modules/identity/src/roles.js';
import { permissionsAfterToggle, roleTableHtml, roleDialogHtml, roleRequestBody, userRoleOptionsHtml, roleLabel } from '../roles.js';

// The Users page's roles panel: consistent checkboxes, a table that says what it holds and what can be done, a dialog that cannot be used to change a built-in role, and role
// names from the server turned into text.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const catalogue = PERMISSIONS.map(permission => ({ ...permission, requires: [...permission.requires] }));
const role = (name, permissions, extra = {}) => ({ id: name, name, displayName: name.replaceAll('_', ' '), description: `${name} role`, system: false, permissions, userCount: 0, rowVersion: 1, ...extra });

test('ticking a permission ticks what it needs; unticking one unticks what needs it', () => {
  assert.deepEqual(permissionsAfterToggle([], 'resource.operate', true, catalogue), ['resource.view', 'resource.operate']);
  assert.deepEqual(permissionsAfterToggle([], 'connection.manage', true, catalogue), ['connection.view', 'connection.manage']);
  assert.deepEqual(permissionsAfterToggle(['resource.view', 'resource.operate', 'resource.tag', 'audit.view'], 'resource.view', false, catalogue), ['audit.view'], 'view is needed by operate and tag');
  assert.deepEqual(permissionsAfterToggle(['resource.view', 'resource.tag'], 'resource.tag', false, catalogue), ['resource.view']);
  assert.deepEqual(permissionsAfterToggle(['resource.view'], 'resource.view', true, catalogue), ['resource.view'], 'ticking what is ticked changes nothing');
});

test('every selection the checkboxes can produce is one the server accepts', async () => {
  const { normalisePermissions } = await import('../../../modules/identity/src/roles.js');
  for (const { key } of catalogue) for (const on of [true, false]) {
    const after = permissionsAfterToggle(catalogue.map(item => item.key), key, on, catalogue);
    if (after.length) assert.doesNotThrow(() => normalisePermissions(after), `${on ? 'tick' : 'untick'} ${key}`);
  }
});

test('the table marks built-in roles, shows the first permissions and the rest as a count, and offers View for built-in and Edit and Delete for custom roles', () => {
  const html = roleTableHtml([role('platform_admin', catalogue.map(item => item.key), { system: true, userCount: 1 }), role('tag_keeper', ['resource.view', 'resource.tag'], { userCount: 2 }), role('empty_one', ['resource.view'])], { esc });
  assert.match(html, /platform admin<\/strong> <span class="badge">Built-in/);
  assert.match(html, /\+5/);
  assert.match(html, /data-role-open="platform_admin">View/);
  assert.doesNotMatch(html, /data-role-delete="platform_admin"/);
  assert.match(html, /data-role-open="tag_keeper">Edit/);
  assert.match(html, /data-role-delete="tag_keeper" disabled title="Held by 2 users/, 'a role people hold cannot be deleted, and the button says why');
  assert.match(html, /data-role-delete="empty_one">Delete/);
  assert.doesNotMatch(html.match(/data-role-delete="empty_one"[^>]*>/)[0], /disabled/);
  assert.match(html, /<span class="sr-only"> role tag keeper<\/span>/, 'each button names its role for assistive technology');
});

test('the dialog for a new role asks for a name and starts with view ticked; a custom role shows its own; a built-in one is read-only with no Save', () => {
  const create = roleDialogHtml(null, catalogue, { esc });
  assert.match(create, /id="role-name"/); assert.match(create, /Create role/);
  assert.match(create, /value="resource\.view" checked/); assert.doesNotMatch(create, /value="resource\.tag" checked/);
  const edit = roleDialogHtml(role('tag_keeper', ['resource.view', 'resource.tag'], { userCount: 1 }), catalogue, { esc });
  assert.doesNotMatch(edit, /id="role-name"/); assert.match(edit, /Save changes/); assert.match(edit, /value="resource\.tag" checked/); assert.match(edit, /1 user holds it/);
  const builtIn = roleDialogHtml(role('operator', ['resource.view'], { system: true }), catalogue, { esc });
  assert.doesNotMatch(builtIn, /id="role-save"/); assert.match(builtIn, /disabled/); assert.match(builtIn, /readonly/); assert.match(builtIn, /cannot be changed or deleted/);
  assert.equal((roleDialogHtml(null, catalogue, { esc, error: 'Nope' }).match(/role="alert"[^>]*>Nope/g) ?? []).length, 1);
  assert.match(create, /<legend>Virtual machines<\/legend>/);
});

test('the request body has a name only when creating', () => {
  assert.deepEqual(roleRequestBody({ name: 'a b', description: 'd', permissions: ['resource.view'] }, true), { name: 'a b', description: 'd', permissions: ['resource.view'] });
  assert.deepEqual(roleRequestBody({ name: 'a b', description: 'd', permissions: ['resource.view'] }, false), { description: 'd', permissions: ['resource.view'] });
});

test('a user’s role selector lists every role; someone with several roles gets an "unchanged" entry so saving does not drop them', () => {
  const roles = [role('operator', [], { system: true }), role('tag_keeper', [])];
  const one = userRoleOptionsHtml(roles, ['tag_keeper'], { esc });
  assert.match(one, /<option value="tag_keeper" selected>/); assert.doesNotMatch(one, /__keep/);
  const many = userRoleOptionsHtml(roles, ['operator', 'tag_keeper'], { esc });
  assert.match(many, /<option value="__keep" selected>operator \+ tag keeper \(unchanged\)/); assert.doesNotMatch(many, /value="operator" selected/);
  assert.match(userRoleOptionsHtml(roles, [], { esc }), /No role \(unchanged\)/);
  assert.match(userRoleOptionsHtml([], ['auditor'], { esc }), /<option value="auditor" selected>/, 'before the roles have loaded, the three built-in ones are offered');
});

test('names and descriptions that came from the server are escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const hostile = role('evil_one', ['resource.view'], { displayName: evil, description: evil });
  for (const html of [roleTableHtml([hostile], { esc }), roleDialogHtml(hostile, catalogue, { esc }), userRoleOptionsHtml([hostile], ['evil_one'], { esc })]) {
    assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
  }
  assert.equal(roleLabel({ name: 'night_shift' }), 'night shift');
});
