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
  assert.deepEqual(grant(['operator']), ['connection.view', 'resource.operate', 'resource.tag', 'resource.view']);
  assert.deepEqual(grant(['auditor']), ['audit.view', 'connection.view', 'resource.view']);
  assert.deepEqual(grant(['platform_admin']), ['alert.manage', 'audit.view', 'connection.manage', 'connection.view', 'identity.manage', 'platform.manage', 'resource.operate', 'resource.tag', 'resource.view']);
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

// ---- custom roles ----------------------------------------------------------------------------------------------------------------------------------------------------

test('a custom role gives a user exactly its permissions, and a change to the role applies to the next request', () => {
  const identity = service();
  const role = identity.createRole({ name: 'Tag Keeper', description: 'tags', permissions: ['resource.tag', 'resource.view'] });
  assert.deepEqual([role.name, role.system, role.userCount, role.rowVersion], ['tag_keeper', false, 0, 1]);
  identity.createUser({ username: 'keeper', displayName: 'Keeper', password: PASSWORD, roles: ['tag_keeper'] });
  const principal = identity.session(identity.authenticate('keeper', PASSWORD).token);
  assert.deepEqual([...principal.user.permissions].sort(), ['resource.tag', 'resource.view']);
  assert.equal(identity.listRoles().find(item => item.name === 'tag_keeper').userCount, 1);
  identity.updateRole('tag_keeper', { permissions: ['resource.view'] }, 1);
  assert.deepEqual(identity.session(identity.authenticate('keeper', PASSWORD).token).user.permissions, ['resource.view']);
});

test('roles: built-in ones are protected, names are unique, versions are checked, and a held role cannot be deleted', () => {
  const identity = service();
  assert.deepEqual(identity.listRoles().map(role => role.name), ['auditor', 'operator', 'platform_admin'].sort((a, b) => a.localeCompare(b)));
  assert.throws(() => identity.updateRole('operator', { permissions: ['resource.view'] }, 1), error => error.code === 'NUV_ROLE_SYSTEM');
  assert.throws(() => identity.deleteRole('auditor'), error => error.code === 'NUV_ROLE_SYSTEM');
  identity.createRole({ name: 'viewers', permissions: ['resource.view'] });
  assert.throws(() => identity.createRole({ name: 'Viewers', permissions: ['resource.view'] }), error => error.code === 'NUV_ROLE_EXISTS');
  assert.throws(() => identity.updateRole('viewers', { permissions: ['resource.view'] }, 9), error => error.message === 'VERSION_CONFLICT');
  assert.equal(identity.updateRole('nobody', { permissions: ['resource.view'] }, 1), null);
  assert.equal(identity.deleteRole('nobody'), null);
  identity.createUser({ username: 'holder', displayName: 'Holder', password: PASSWORD, roles: ['viewers'] });
  assert.throws(() => identity.deleteRole('viewers'), error => error.code === 'NUV_ROLE_IN_USE');
  assert.throws(() => identity.createUser({ username: 'ghost', displayName: 'Ghost', password: PASSWORD, roles: ['no_such_role'] }), error => error.message === 'USER_INVALID');
});

test('the custom role limit holds', () => {
  const identity = service();
  for (let i = 0; i < 50; i++) identity.createRole({ name: `role_${i}`, permissions: ['resource.view'] });
  assert.throws(() => identity.createRole({ name: 'one_too_many', permissions: ['resource.view'] }), error => error.code === 'NUV_ROLE_LIMIT');
});

// ---- two-factor sign-in ----------------------------------------------------------------------------------------------------------------------------------------------

import { totpCode } from '../src/totp.js';
// A service with a clock the test moves: codes are bound to 30-second steps, and the lock-out and replay rules are about time.
function clocked() {
  const time = { now: 1_800_000_000_000 };
  const identity = new IdentityService({ bootstrapPassword: PASSWORD, clock: () => time.now });
  const code = (secret, steps = 0) => totpCode(secret, time.now + steps * 30_000);
  return { identity, time, code, advance: ms => { time.now += ms; } };
}
function signedIn(identity, username = 'mfa.user', roles = ['operator']) {
  identity.createUser({ username, displayName: 'MFA User', password: PASSWORD, roles });
  const login = identity.authenticate(username, PASSWORD);
  return { login, userId: login.user.id, sessionId: identity.session(login.token).session.idHash, token: login.token };
}
function enrolled({ identity, code }, who) {
  const started = identity.mfaStartEnrollment(who.userId, {});
  const result = identity.mfaConfirmEnrollment(who.userId, who.sessionId, code(started.secret));
  return { ...result, secret: started.secret };
}
const newSession = (identity, username = 'mfa.user') => { const login = identity.authenticate(username, PASSWORD); return { id: identity.session(login.token).session.idHash, token: login.token, mfa: login.mfa }; };
const code_ = expected => error => error.code === expected;

test('without a policy or an authenticator a session is verified at once; enrolling needs a correct code and returns ten backup codes once', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity);
  assert.equal(who.login.mfa.state, 'verified');
  assert.deepEqual(identity.mfaStatus(who.userId), { enrolled: false, enrolledAt: null, backupCodesRemaining: 0, required: false });
  const started = identity.mfaStartEnrollment(who.userId, { account: 'ann@example.com' });
  assert.match(started.secret, /^[A-Z2-7]{32}$/);
  assert.match(started.uri, /^otpauth:\/\/totp\/Nuvrion:ann%40example\.com\?secret=/);
  assert.throws(() => identity.mfaConfirmEnrollment(who.userId, who.sessionId, '000000'), code_('NUV_MFA_CODE_INVALID'));
  assert.equal(identity.mfaStatus(who.userId).enrolled, false, 'a wrong code enrols nothing');
  const { backupCodes } = identity.mfaConfirmEnrollment(who.userId, who.sessionId, lab.code(started.secret));
  assert.equal(backupCodes.length, 10);
  assert.deepEqual([identity.mfaStatus(who.userId).enrolled, identity.mfaStatus(who.userId).backupCodesRemaining], [true, 10]);
  assert.equal(identity.session(who.token).mfa.state, 'verified', 'the session that enrolled is verified');
  assert.equal(identity.listUsers().find(user => user.id === who.userId).mfaEnrolled, true);
  assert.throws(() => identity.mfaStartEnrollment(who.userId), code_('NUV_MFA_ALREADY_ENROLLED'));
  assert.throws(() => identity.mfaConfirmEnrollment(who.userId, who.sessionId, lab.code(started.secret)), code_('NUV_MFA_ALREADY_ENROLLED'));
});

test('after enrolling, a new sign-in needs a code; each code works once, each backup code works once, and other sessions must verify again', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity), { secret, backupCodes } = enrolled(lab, who);
  assert.equal(identity.session(who.token).mfa.state, 'verified');
  const other = newSession(identity);
  assert.equal(other.mfa.state, 'verification_required');
  assert.throws(() => identity.mfaVerify(who.userId, other.id, { code: lab.code(secret) }), code_('NUV_MFA_CODE_INVALID'), 'the code that enrolled is already used');
  assert.equal(identity.mfaVerify(who.userId, other.id, { code: lab.code(secret, 1) }).method, 'totp');
  assert.equal(identity.session(other.token).mfa.state, 'verified');
  const third = newSession(identity);
  assert.throws(() => identity.mfaVerify(who.userId, third.id, { code: lab.code(secret, 1) }), code_('NUV_MFA_CODE_INVALID'), 'a code is good once');
  assert.throws(() => identity.mfaVerify(who.userId, third.id, { code: lab.code(secret, -1) }), code_('NUV_MFA_CODE_INVALID'), 'and an older one is no use once a newer is used');
  lab.advance(60_000);
  assert.equal(identity.mfaVerify(who.userId, third.id, { code: lab.code(secret) }).method, 'totp', 'a later step works');
  const fourth = newSession(identity), used = backupCodes[0];
  assert.deepEqual(identity.mfaVerify(who.userId, fourth.id, { backupCode: used.toUpperCase().replace('-', ' ') }), { method: 'backup', backupCodesRemaining: 9 });
  const fifth = newSession(identity);
  assert.throws(() => identity.mfaVerify(who.userId, fifth.id, { backupCode: used }), code_('NUV_MFA_CODE_INVALID'), 'a backup code is good once');
  assert.equal(identity.mfaVerify(who.userId, fifth.id, { backupCode: backupCodes[1] }).backupCodesRemaining, 8);
  assert.equal(identity.session(who.token).mfa.state, 'verified', 'the session that enrolled stays verified');
});

test('five wrong codes end the sign-in; ten in a quarter of an hour lock the account, even against a correct code, until the time is up', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity), { secret } = enrolled(lab, who);
  let a = newSession(identity);
  for (let i = 0; i < 4; i++) assert.throws(() => identity.mfaVerify(who.userId, a.id, { code: '000000' }), code_('NUV_MFA_CODE_INVALID'));
  assert.throws(() => identity.mfaVerify(who.userId, a.id, { code: '000000' }), code_('NUV_MFA_SESSION_REVOKED'));
  assert.equal(identity.session(a.token), null, 'the fifth wrong code ended the session');
  a = newSession(identity);
  for (let i = 0; i < 4; i++) assert.throws(() => identity.mfaVerify(who.userId, a.id, { code: '111111' }), code_('NUV_MFA_CODE_INVALID'));
  assert.throws(() => identity.mfaVerify(who.userId, a.id, { code: '111111' }), code_('NUV_MFA_SESSION_REVOKED'), 'ten wrong codes in all');
  a = newSession(identity);
  const refused = (() => { try { identity.mfaVerify(who.userId, a.id, { code: lab.code(secret, 1) }); } catch (error) { return error; } })();
  assert.equal(refused.code, 'NUV_MFA_THROTTLED', 'locked: even the right code is not looked at');
  assert.ok(refused.retryAfterSeconds > 890 && refused.retryAfterSeconds <= 900);
  lab.advance(901_000);
  assert.equal(identity.mfaVerify(who.userId, a.id, { code: lab.code(secret) }).method, 'totp', 'after the lock the person can sign in again');
});

test('failures older than the window do not add up', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity), { secret } = enrolled(lab, who);
  for (let round = 0; round < 3; round++) {
    const a = newSession(identity);
    for (let i = 0; i < 4; i++) assert.throws(() => identity.mfaVerify(who.userId, a.id, { code: '000000' }), code_('NUV_MFA_CODE_INVALID'));
    lab.advance(16 * 60_000);
  }
  const b = newSession(identity);
  assert.equal(identity.mfaVerify(who.userId, b.id, { code: lab.code(secret) }).method, 'totp', 'twelve wrong codes over three quarters of an hour never locked the account');
});

test('a request that is not one code is refused as invalid, not as a wrong code, and does not count against the person', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity); enrolled(lab, who);
  const a = newSession(identity);
  for (let i = 0; i < 12; i++) for (const bad of [null, [], {}, { code: 123456 }, { code: '1', backupCode: 'x' }, { code: 'x'.repeat(65) }, { other: '1' }]) assert.throws(() => identity.mfaVerify(who.userId, a.id, bad), code_('NUV_MFA_REQUEST_INVALID'), JSON.stringify(bad));
  assert.equal(identity.session(a.token).mfa.state, 'verification_required');
});

test('requiring it for a person: they must enrol at once (a session already open too), cannot turn it off, and keep the requirement after a reset', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity, 'required.user', ['operator']), other = signedIn(identity, 'free.user', ['operator']);
  const user = () => identity.listUsers().find(item => item.id === who.userId);
  assert.equal(user().mfaRequired, false);
  const updated = identity.updateUser(who.userId, { status: 'active', roles: ['operator'], mfaRequired: true }, user().rowVersion);
  assert.equal(updated.mfaRequired, true);
  assert.equal(identity.session(who.token).mfa.state, 'enrollment_required', 'an open session is held at enrolment at once');
  assert.equal(identity.session(other.token).mfa.state, 'verified', 'nobody else is affected: it is chosen per person');
  assert.equal(identity.authenticate('required.user', PASSWORD).mfa.state, 'enrollment_required');
  assert.deepEqual([identity.mfaStatus(who.userId).required, identity.mfaStatus(other.userId).required], [true, false]);
  const { secret } = enrolled(lab, who);
  assert.equal(identity.session(who.token).mfa.state, 'verified');
  lab.advance(30_000);
  assert.throws(() => identity.mfaDisable(who.userId, lab.code(secret)), code_('NUV_MFA_REQUIRED_FOR_ACCOUNT'));
  assert.deepEqual(identity.mfaReset(who.userId), { reset: true });
  assert.equal(identity.listUsers().find(item => item.id === who.userId).mfaRequired, true, 'a reset removes the enrolment, not the requirement');
  assert.equal(identity.authenticate('required.user', PASSWORD).mfa.state, 'enrollment_required');
  // an update that does not mention it leaves it alone; one that asks for nothing required turns it off; a non-boolean is refused
  const version = () => identity.listUsers().find(item => item.id === who.userId).rowVersion;
  assert.equal(identity.updateUser(who.userId, { status: 'active', roles: ['operator'] }, version()).mfaRequired, true);
  assert.throws(() => identity.updateUser(who.userId, { status: 'active', roles: ['operator'], mfaRequired: 'yes' }, version()), error => error.message === 'USER_INVALID');
  assert.equal(identity.updateUser(who.userId, { status: 'active', roles: ['operator'], mfaRequired: false }, version()).mfaRequired, false);
  assert.equal(identity.authenticate('required.user', PASSWORD).mfa.state, 'verified');
});

test('turning it off, new backup codes and an administrator’s reset', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity), { secret, backupCodes } = enrolled(lab, who);
  assert.throws(() => identity.mfaDisable(who.userId, '000000'), code_('NUV_MFA_CODE_INVALID'));
  lab.advance(30_000);
  const fresh = identity.mfaRegenerateBackupCodes(who.userId, lab.code(secret)).backupCodes;
  assert.equal(fresh.length, 10); assert.ok(fresh.every(code => !backupCodes.includes(code)));
  const a = newSession(identity);
  assert.throws(() => identity.mfaVerify(who.userId, a.id, { backupCode: backupCodes[0] }), code_('NUV_MFA_CODE_INVALID'), 'the old backup codes no longer work');
  assert.equal(identity.mfaVerify(who.userId, a.id, { backupCode: fresh[0] }).backupCodesRemaining, 9);
  lab.advance(30_000);
  assert.deepEqual(identity.mfaDisable(who.userId, lab.code(secret)), { disabled: true });
  assert.equal(identity.mfaStatus(who.userId).enrolled, false);
  assert.equal(identity.authenticate('mfa.user', PASSWORD).mfa.state, 'verified');
  const again = enrolled(lab, who);
  assert.deepEqual(identity.mfaReset(who.userId), { reset: true });
  assert.equal(identity.mfaStatus(who.userId).enrolled, false);
  assert.equal(identity.session(who.token), null, 'a reset ends the person’s sessions');
  assert.equal(identity.mfaReset('00000000-0000-4000-8000-000000000000'), null);
  assert.ok(again.secret);
});

test('a pending secret is not an enrolment, and the secret is not kept in the clear', () => {
  const lab = clocked(), { identity } = lab, who = signedIn(identity), started = identity.mfaStartEnrollment(who.userId, {});
  assert.throws(() => identity.mfaVerify(who.userId, who.sessionId, { code: '123456' }), code_('NUV_MFA_NOT_ENROLLED'));
  assert.ok(!JSON.stringify(identity.listUsers()).includes(started.secret));
});

// ---- creating accounts and passwords -----------------------------------------------------------------------------------------------------------------------------------

test('an account made by an administrator can start with a password the person must replace, and require two-step verification', () => {
  const identity = service();
  const { user } = identity.createUser({ username: 'new.person', displayName: 'New Person', password: PASSWORD, roles: ['auditor'], mustChangePassword: true, mfaRequired: true });
  assert.deepEqual([user.status, user.roles, user.mustChangePassword, user.mfaRequired], ['active', ['auditor'], true, true]);
  const login = identity.authenticate('new.person', PASSWORD);
  assert.equal(login.user.mustChangePassword, true);
  assert.equal(login.mfa.state, 'enrollment_required');
  const plain = identity.createUser({ username: 'plain.person', displayName: 'Plain', password: PASSWORD }).user;
  assert.deepEqual([plain.mustChangePassword, plain.mfaRequired], [false, false], 'by default nothing is forced');
});

test('changing your own password needs the current one, a new one of 12 characters that differs, and ends your other sessions but not this one', () => {
  const identity = service();
  const { user } = identity.createUser({ username: 'changer', displayName: 'Changer', password: PASSWORD, mustChangePassword: true });
  const first = identity.authenticate('changer', PASSWORD), second = identity.authenticate('changer', PASSWORD);
  const firstId = identity.session(first.token).session.idHash;
  const NEXT = 'A-Brand-New-Password-7!';   // secret-scan:allow (fake test credential)
  assert.throws(() => identity.changePassword(user.id, firstId, 'not the password', NEXT), error => error.message === 'PASSWORD_INCORRECT');
  assert.throws(() => identity.changePassword(user.id, firstId, PASSWORD, 'short'), error => error.message === 'PASSWORD_TOO_SHORT');
  assert.throws(() => identity.changePassword(user.id, firstId, PASSWORD, PASSWORD), error => error.message === 'PASSWORD_UNCHANGED');
  assert.throws(() => identity.changePassword(user.id, firstId, undefined, NEXT), error => error.message === 'PASSWORD_INCORRECT');
  assert.equal(identity.session(first.token).user.mustChangePassword, true, 'refused attempts changed nothing');
  assert.deepEqual(identity.changePassword(user.id, firstId, PASSWORD, NEXT), { changed: true, otherSessionsEnded: 1 });
  assert.notEqual(identity.session(first.token), null, 'this session carries on');
  assert.equal(identity.session(second.token), null, 'the other one ended');
  assert.equal(identity.session(first.token).user.mustChangePassword, false);
  assert.equal(identity.authenticate('changer', PASSWORD), null, 'the old password no longer works');
  assert.notEqual(identity.authenticate('changer', NEXT), null);
});

test('an administrator sets a temporary password: the person must replace it, every session of theirs ends, and an unknown person is not found', () => {
  const identity = service();
  const { user } = identity.createUser({ username: 'forgetful', displayName: 'Forgetful', password: PASSWORD });
  const login = identity.authenticate('forgetful', PASSWORD);
  const TEMPORARY = 'Temporary-Password-42!';   // secret-scan:allow (fake test credential)
  assert.throws(() => identity.setPassword(user.id, 'short'), error => error.message === 'PASSWORD_TOO_SHORT');
  assert.deepEqual(identity.setPassword(user.id, TEMPORARY), { set: true, sessionsEnded: 1 });
  assert.equal(identity.session(login.token), null);
  assert.equal(identity.authenticate('forgetful', PASSWORD), null);
  assert.equal(identity.authenticate('forgetful', TEMPORARY).user.mustChangePassword, true);
  assert.equal(identity.setPassword('00000000-0000-4000-8000-000000000000', TEMPORARY), null);
  assert.equal(identity.setPassword(user.id, TEMPORARY, { mustChange: false }).set, true);
  assert.equal(identity.authenticate('forgetful', TEMPORARY).user.mustChangePassword, false);
});
