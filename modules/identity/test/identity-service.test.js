import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityService, parseCookies } from '../src/identity-service.js';

const PASSWORD = 'A-long-enough-password-1'; // secret-scan:allow (fake test credential)
function service(options = {}) {
  return new IdentityService({ bootstrapPassword: PASSWORD, ...options });
}
const withDate = (t, start = Date.parse('2026-10-06T00:00:00Z')) => { t.mock.timers.enable({ apis: ['Date'], now: start }); return t.mock.timers; };

test('a bootstrap administrator exists and can sign in', () => {
  const identity = service();
  const result = identity.authenticate('admin', PASSWORD);
  assert.ok(result.token && result.csrf);
  assert.deepEqual(result.user.roles, ['platform_admin']);
});

test('the three roles carry exactly the documented permissions', () => {
  const identity = service();
  const grant = roles => identity.createUser({ username: `u-${roles.join('-')}`, displayName: 'Test', password: PASSWORD, roles }).user.permissions.sort();
  assert.deepEqual(grant(['operator']), ['connection.view', 'resource.operate', 'resource.view']);
  assert.deepEqual(grant(['auditor']), ['audit.view', 'connection.view', 'resource.view']);
  assert.deepEqual(grant(['platform_admin']), ['audit.view', 'connection.manage', 'connection.view', 'identity.manage', 'platform.manage', 'resource.operate', 'resource.view']);
});

test('authorize reflects the role, and nothing is allowed without a principal', () => {
  const identity = service();
  identity.createUser({ username: 'ops', displayName: 'Ops', password: PASSWORD, roles: ['operator'] });
  const principal = identity.session(identity.authenticate('ops', PASSWORD).token);
  assert.equal(identity.authorize(principal, 'resource.operate'), true);
  assert.equal(identity.authorize(principal, 'platform.manage'), false);
  assert.equal(identity.authorize(null, 'resource.view'), false);
});

test('wrong passwords, unknown users and non-active accounts cannot sign in', () => {
  const identity = service();
  identity.createUser({ username: 'pending', displayName: 'P', password: PASSWORD, status: 'pending' });
  assert.equal(identity.authenticate('admin', 'wrong'), null);
  assert.equal(identity.authenticate('nobody', PASSWORD), null);
  assert.equal(identity.authenticate('pending', PASSWORD), null);
});

test('passwords shorter than the minimum are refused, and usernames are unique', () => {
  const identity = service();
  assert.throws(() => identity.createUser({ username: 'short', displayName: 'S', password: 'tooshort' }), /PASSWORD_TOO_SHORT/);
  assert.throws(() => identity.createUser({ username: 'ADMIN', displayName: 'Dup', password: PASSWORD }), /USERNAME_EXISTS/);
  assert.throws(() => identity.createUser({ username: 'badrole', displayName: 'B', password: PASSWORD, roles: ['root'] }), /USER_INVALID/);
});

test('sessions expire after the idle timeout, and activity extends them', (t) => {
  const clock = withDate(t);
  const identity = service({ idleTimeoutMs: 60_000, absoluteTimeoutMs: 3_600_000 });
  const { token } = identity.authenticate('admin', PASSWORD);
  clock.tick(50_000);
  assert.ok(identity.session(token), 'still valid before the idle limit (and this touch extends it)');
  clock.tick(50_000);
  assert.ok(identity.session(token), 'activity kept it alive');
  clock.tick(61_000);
  assert.equal(identity.session(token), null, 'idle for longer than the limit');
});

test('sessions expire at the absolute timeout no matter how active they are', (t) => {
  const clock = withDate(t);
  const identity = service({ idleTimeoutMs: 60_000, absoluteTimeoutMs: 150_000 });
  const { token } = identity.authenticate('admin', PASSWORD);
  for (let i = 0; i < 2; i++) { clock.tick(50_000); assert.ok(identity.session(token)); }
  clock.tick(51_000);
  assert.equal(identity.session(token), null);
});

test('logout ends the session', () => {
  const identity = service();
  const { token } = identity.authenticate('admin', PASSWORD);
  identity.logout(token);
  assert.equal(identity.session(token), null);
  assert.equal(identity.session(undefined), null);
  assert.equal(identity.session('not-a-token'), null);
});

test('the last active administrator cannot be demoted, disabled or locked', () => {
  const identity = service();
  const admin = identity.listUsers().find(u => u.username === 'admin');
  assert.throws(() => identity.updateUser(admin.id, { status: 'disabled', roles: ['platform_admin'] }, admin.rowVersion), /LAST_ADMIN/);
  assert.throws(() => identity.updateUser(admin.id, { status: 'active', roles: ['operator'] }, admin.rowVersion), /LAST_ADMIN/);
});

test('with a second administrator the first can be changed', () => {
  const identity = service();
  identity.createUser({ username: 'second', displayName: 'Second', password: PASSWORD, roles: ['platform_admin'] });
  const admin = identity.listUsers().find(u => u.username === 'admin');
  const updated = identity.updateUser(admin.id, { status: 'active', roles: ['operator'] }, admin.rowVersion);
  assert.deepEqual(updated.roles, ['operator']);
  assert.equal(updated.rowVersion, admin.rowVersion + 1);
});

test('updates require the current row version', () => {
  const identity = service();
  identity.createUser({ username: 'ops', displayName: 'Ops', password: PASSWORD, roles: ['operator'] });
  const ops = identity.listUsers().find(u => u.username === 'ops');
  assert.throws(() => identity.updateUser(ops.id, { status: 'active', roles: ['auditor'] }, ops.rowVersion + 5), /VERSION_CONFLICT/);
  assert.throws(() => identity.updateUser(ops.id, { status: 'active', roles: [] }, ops.rowVersion), /USER_INVALID/);
});

test('disabling a user revokes their sessions immediately', () => {
  const identity = service();
  identity.createUser({ username: 'ops', displayName: 'Ops', password: PASSWORD, roles: ['operator'] });
  const { token } = identity.authenticate('ops', PASSWORD);
  const ops = identity.listUsers().find(u => u.username === 'ops');
  identity.updateUser(ops.id, { status: 'disabled', roles: ['operator'] }, ops.rowVersion);
  assert.equal(identity.session(token), null);
  assert.equal(identity.authenticate('ops', PASSWORD), null);
});

test('a recovery code resets the password once, ends sessions and issues a new code', () => {
  const identity = service();
  const { recoveryCode } = identity.createUser({ username: 'ops', displayName: 'Ops', password: PASSWORD, roles: ['operator'] });
  const { token } = identity.authenticate('ops', PASSWORD);
  const rotated = identity.resetPassword('ops', recoveryCode, 'a-brand-new-password-2');
  assert.ok(rotated.recoveryCode && rotated.recoveryCode !== recoveryCode);
  assert.equal(identity.session(token), null, 'old sessions are revoked');
  assert.ok(identity.authenticate('ops', 'a-brand-new-password-2'));
  assert.equal(identity.resetPassword('ops', recoveryCode, 'yet-another-password-3'), null, 'the used code no longer works');
  assert.equal(identity.resetPassword('ops', 'wrong-code', 'yet-another-password-3'), null);
  assert.equal(identity.resetPassword('nobody', recoveryCode, 'yet-another-password-3'), null);
});

test('users can list and revoke only their own sessions', () => {
  const identity = service();
  identity.createUser({ username: 'ops', displayName: 'Ops', password: PASSWORD, roles: ['operator'] });
  const mine = identity.authenticate('ops', PASSWORD), other = identity.authenticate('admin', PASSWORD);
  const ops = mine.user, admin = other.user;
  const listed = identity.listSessions(ops.id, mine.token);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].current, true);
  assert.deepEqual(identity.revokeSession(ops.id, identity.listSessions(admin.id, other.token)[0].id), { revoked: 0 }, "cannot revoke someone else's session");
  assert.deepEqual(identity.revokeSession(ops.id, listed[0].id), { revoked: 1 });
});

test('cookie parsing handles empty headers, several cookies and encoded values', () => {
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1; b=two%20words; c=x=y'), { a: '1', b: 'two words', c: 'x=y' });
});

test('a new account needs a well-formed username and display name; anything else is USER_INVALID, never a crash', () => {
  const identity = service();
  const create = over => () => identity.createUser({ username: 'valid.name', displayName: 'Valid Name', password: PASSWORD, ...over });
  for (const [label, over] of [
    ['a missing username', { username: undefined }], ['a null username', { username: null }], ['a numeric username', { username: 12345 }], ['an object username', { username: { a: 1 } }],
    ['a username with a space', { username: 'two words' }], ['a username with a symbol', { username: 'bad!name' }], ['an e-mail address', { username: 'a@example.com' }],
    ['a two-letter username', { username: 'ab' }], ['a 129-letter username', { username: 'a'.repeat(129) }], ['an empty username', { username: '   ' }],
    ['a missing display name', { displayName: undefined }], ['a blank display name', { displayName: '   ' }], ['a display name over 200 characters', { displayName: 'n'.repeat(201) }], ['a numeric display name', { displayName: 7 }]
  ]) assert.throws(create(over), /USER_INVALID/, label);
  assert.ok(create({ username: '  Mixed.Case_1-x  ' })().user.username === 'Mixed.Case_1-x', 'surrounding spaces are trimmed, case is kept for display');
  assert.ok(create({ username: 'a'.repeat(128), displayName: 'n'.repeat(200) })(), 'the limits themselves are allowed');
});

test('the 12-character password minimum always applies, for new accounts and for resets; no option turns it off', () => {
  const identity = service({ allowWeakPasswords: true });          // the old lab option no longer exists, and is ignored
  assert.throws(() => identity.createUser({ username: 'weak.one', displayName: 'W', password: 'short' }), /PASSWORD_TOO_SHORT/);
  assert.throws(() => identity.createUser({ username: 'weak.two', displayName: 'W', password: '11-chars-xx' }), /PASSWORD_TOO_SHORT/);
  assert.throws(() => identity.createUser({ username: 'weak.three', displayName: 'W', password: undefined }), /PASSWORD_TOO_SHORT/);
  assert.ok(identity.createUser({ username: 'ok.one', displayName: 'W', password: '12-chars-xxx' }), 'exactly 12 is enough'); // secret-scan:allow (fake test credential)
  const { recoveryCode } = identity.createUser({ username: 'reset.me', displayName: 'R', password: PASSWORD });
  assert.throws(() => identity.resetPassword('reset.me', recoveryCode, 'short'), /PASSWORD_TOO_SHORT/);
  assert.ok(identity.authenticate('reset.me', PASSWORD), 'a refused reset leaves the old password in place');
  assert.ok(identity.resetPassword('reset.me', recoveryCode, '12-chars-new'), 'the recovery code still works after a refused attempt');
});

test('an invalid request is reported before a duplicate one, and a duplicate is only reported for a valid request', () => {
  const identity = service();
  assert.throws(() => identity.createUser({ username: 'ADMIN', displayName: 'Dup', password: PASSWORD }), /USERNAME_EXISTS/);
  assert.throws(() => identity.createUser({ username: 'admin', displayName: 'Dup', password: 'short' }), /PASSWORD_TOO_SHORT/);
  assert.throws(() => identity.createUser({ username: 'admin', displayName: '', password: PASSWORD }), /USER_INVALID/);
});
