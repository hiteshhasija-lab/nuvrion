import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresIdentityService } from '../src/postgres-identity-service.js';
import { IdentityService } from '../src/identity-service.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production identity service against a real PostgreSQL. It must accept and refuse exactly what the in-memory service does
// (the unit tests there cover the rules), and the database must hold up under simultaneous sign-ups.
const database = { skip: skipDatabaseTests };
const PASSWORD = 'A-long-enough-password-1'; // secret-scan:allow (fake test credential)
const db = skipDatabaseTests ? null : await createTestDatabase();
const identity = db ? await PostgresIdentityService.create(db.pool, { bootstrapPassword: PASSWORD }) : null;
const memory = new IdentityService({ bootstrapPassword: PASSWORD });
after(async () => { await db?.drop(); });
const count = async () => (await db.pool.query('SELECT count(*)::int AS n FROM identity.users')).rows[0].n;
const outcome = async work => { try { await work(); return 'ok'; } catch (error) { return error.message; } };

const CASES = [
  ['a valid account', { username: 'valid.one', displayName: 'Valid One', password: PASSWORD }, 'ok'],
  ['a missing username', { displayName: 'X', password: PASSWORD }, 'USER_INVALID'],
  ['a null username', { username: null, displayName: 'X', password: PASSWORD }, 'USER_INVALID'],
  ['a numeric username', { username: 123456, displayName: 'X', password: PASSWORD }, 'USER_INVALID'],
  ['a username with a space', { username: 'two words', displayName: 'X', password: PASSWORD }, 'USER_INVALID'],
  ['an e-mail address as username', { username: 'a@example.com', displayName: 'X', password: PASSWORD }, 'USER_INVALID'],
  ['a two-letter username', { username: 'ab', displayName: 'X', password: PASSWORD }, 'USER_INVALID'],
  ['a missing display name', { username: 'no.display', password: PASSWORD }, 'USER_INVALID'],
  ['a blank display name', { username: 'blank.display', displayName: '  ', password: PASSWORD }, 'USER_INVALID'],
  ['a display name over 200 characters', { username: 'long.display', displayName: 'n'.repeat(201), password: PASSWORD }, 'USER_INVALID'],
  ['an unknown role', { username: 'bad.role', displayName: 'X', password: PASSWORD, roles: ['root'] }, 'USER_INVALID'],
  ['roles that are not a list', { username: 'bad.roles', displayName: 'X', password: PASSWORD, roles: 'operator' }, 'USER_INVALID'],
  ['a too-short password', { username: 'short.pw', displayName: 'X', password: 'short' }, 'PASSWORD_TOO_SHORT'],
  ['an 11-character password', { username: 'eleven.pw', displayName: 'X', password: '11-chars-xx' }, 'PASSWORD_TOO_SHORT'],
  ['a missing password', { username: 'no.pw', displayName: 'X' }, 'PASSWORD_TOO_SHORT'],
  ['a 12-character password', { username: 'twelve.pw', displayName: 'X', password: '12-chars-xxx' }, 'ok'], // secret-scan:allow (fake test credential)
  ['the existing administrator again, in another case', { username: 'ADMIN', displayName: 'X', password: PASSWORD }, 'USERNAME_EXISTS']
];

test('the PostgreSQL and in-memory services accept and refuse exactly the same new accounts', database, async () => {
  for (const [label, input, expected] of CASES) {
    const [fromDatabase, fromMemory] = [await outcome(() => identity.createUser(input)), await outcome(() => memory.createUser(input))];
    assert.equal(fromDatabase, expected, `PostgreSQL: ${label}`);
    assert.equal(fromMemory, expected, `in memory: ${label}`);
  }
});

test('refused accounts leave nothing behind: only the administrator and the accepted accounts exist', database, async () => {
  const accepted = CASES.filter(([, , expected]) => expected === 'ok').length;
  assert.equal(await count(), 1 + accepted);
  const names = (await db.pool.query('SELECT normalized_username FROM identity.users')).rows.map(r => r.normalized_username).sort();
  assert.deepEqual(names, ['admin', 'twelve.pw', 'valid.one']);
});

test('usernames are unique regardless of case or surrounding spaces', database, async () => {
  await identity.createUser({ username: 'Casey.Jones', displayName: 'Casey', password: PASSWORD });
  for (const clash of ['casey.jones', 'CASEY.JONES', '  Casey.Jones  ']) {
    await assert.rejects(() => identity.createUser({ username: clash, displayName: 'Other', password: PASSWORD }), /USERNAME_EXISTS/, JSON.stringify(clash));
  }
});

test('simultaneous sign-ups for one username create exactly one account; the others are told it is taken', database, async () => {
  const before = await count();
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => identity.createUser({ username: 'race.winner', displayName: `Racer ${i}`, password: PASSWORD, status: 'pending' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const failed of results.filter(r => r.status === 'rejected')) assert.equal(failed.reason.message, 'USERNAME_EXISTS', 'a clash is reported as a clash, not as a database error');
  assert.equal(await count(), before + 1);
});

test('a pending account cannot sign in, and a stored username keeps the casing it was given', database, async () => {
  await identity.createUser({ username: 'Pending.Pat', displayName: 'Pat', password: PASSWORD, status: 'pending' });
  assert.equal(await identity.authenticate('pending.pat', PASSWORD), null);
  const row = (await db.pool.query("SELECT username, normalized_username FROM identity.users WHERE normalized_username = 'pending.pat'")).rows[0];
  assert.deepEqual(row, { username: 'Pending.Pat', normalized_username: 'pending.pat' });
});

test('a password reset needs 12 characters; a refused attempt changes nothing and the recovery code still works', database, async () => {
  const { recoveryCode } = await identity.createUser({ username: 'reset.rae', displayName: 'Rae', password: PASSWORD });
  await assert.rejects(() => identity.resetPassword('reset.rae', recoveryCode, 'short'), /PASSWORD_TOO_SHORT/);
  assert.ok(await identity.authenticate('reset.rae', PASSWORD), 'the old password still works');
  const rotated = await identity.resetPassword('reset.rae', recoveryCode, '12-chars-new');
  assert.ok(rotated?.recoveryCode, 'the code was not used up by the refused attempt');
  assert.equal(await identity.authenticate('reset.rae', PASSWORD), null);
  assert.ok(await identity.authenticate('reset.rae', '12-chars-new'));
  assert.equal(await identity.resetPassword('reset.rae', 'wrong-code', '12-chars-newer'), null);
});

// ---- sessions, user administration and recovery codes -------------------------------------------------------------
const extra = [];
after(async () => { for (const database of extra) await database.drop(); });
async function isolated() {            // a database of its own, so counting administrators is exact
  const own = await createTestDatabase(); extra.push(own);
  return { ...own, identity: await PostgresIdentityService.create(own.pool, { bootstrapPassword: PASSWORD }) };
}
let seq = 0;
const newUser = (over = {}) => identity.createUser({ username: `user.${++seq}.${Date.now() % 100000}`, displayName: 'Test User', password: PASSWORD, ...over });
const activeUser = async (roles = ['operator']) => { const { user } = await newUser({ roles }); return user; };
const sessionRow = async token => (await db.pool.query('SELECT * FROM identity.sessions WHERE session_id_hash = $1', [(await import('node:crypto')).createHash('sha256').update(token).digest('hex')])).rows[0];

test('signing in creates a session whose token and CSRF token are stored only as hashes', database, async () => {
  const user = await activeUser();
  const result = await identity.authenticate(user.username.toUpperCase(), PASSWORD);   // the username is not case sensitive
  assert.ok(result.token && result.csrf);
  assert.deepEqual([result.user.id, result.policy.idleTimeoutMs > 0], [user.id, true]);
  const stored = await sessionRow(result.token);
  assert.equal(JSON.stringify(stored).includes(result.token), false);
  assert.equal(JSON.stringify(stored).includes(result.csrf), false);
});

test('wrong passwords, unknown users and accounts that are not active cannot sign in', database, async () => {
  const user = await activeUser();
  assert.equal(await identity.authenticate(user.username, 'wrong-password-123'), null);
  assert.equal(await identity.authenticate('nobody.at.all', PASSWORD), null);
  const pending = (await newUser({ status: 'pending' })).user;
  assert.equal(await identity.authenticate(pending.username, PASSWORD), null, 'pending');
  const [{ rowVersion }] = (await identity.listUsers()).filter(u => u.id === user.id);
  await identity.updateUser(user.id, { status: 'locked', roles: ['operator'] }, rowVersion);
  assert.equal(await identity.authenticate(user.username, PASSWORD), null, 'locked');
});

test('a session is found by its token; a wrong CSRF token, an unknown token and no token are not', database, async () => {
  const user = await activeUser(), { token, csrf } = await identity.authenticate(user.username, PASSWORD);
  const found = await identity.session(token);
  assert.equal(found.user.id, user.id);
  assert.equal(found.session.csrfVerified, false, 'no CSRF token was supplied, so none is claimed as verified');
  assert.equal((await identity.session(token, csrf)).session.csrfVerified, true);
  assert.equal(await identity.session(token, 'wrong-csrf-token'), null);
  assert.equal(await identity.session('not-a-token'), null);
  assert.equal(await identity.session(undefined), null);
  assert.equal(await identity.session(''), null);
});

test('sessions end when idle too long or past the absolute limit, and activity extends the idle time but never past the limit', database, async () => {
  const user = await activeUser(), { token } = await identity.authenticate(user.username, PASSWORD), hash = (await sessionRow(token)).session_id_hash;
  await db.pool.query("UPDATE identity.sessions SET idle_expires_at = now() + interval '1 minute' WHERE session_id_hash = $1", [hash]);
  await identity.session(token);
  const extended = (await db.pool.query('SELECT idle_expires_at FROM identity.sessions WHERE session_id_hash = $1', [hash])).rows[0].idle_expires_at;
  assert.ok(extended.getTime() > Date.now() + 10 * 60_000, 'activity pushed the idle limit out');
  await db.pool.query("UPDATE identity.sessions SET absolute_expires_at = now() + interval '1 minute' WHERE session_id_hash = $1", [hash]);
  await identity.session(token);
  const capped = (await db.pool.query('SELECT idle_expires_at, absolute_expires_at FROM identity.sessions WHERE session_id_hash = $1', [hash])).rows[0];
  assert.ok(capped.idle_expires_at <= capped.absolute_expires_at, 'the idle limit never goes beyond the absolute limit');
  await db.pool.query("UPDATE identity.sessions SET idle_expires_at = now() - interval '1 second' WHERE session_id_hash = $1", [hash]);
  assert.equal(await identity.session(token), null, 'idle for too long');
  const second = await identity.authenticate(user.username, PASSWORD);
  await db.pool.query("UPDATE identity.sessions SET absolute_expires_at = now() - interval '1 second' WHERE session_id_hash = $1", [(await sessionRow(second.token)).session_id_hash]);
  assert.equal(await identity.session(second.token), null, 'past the absolute limit');
});

test('logging out ends the session, and logging out with an unknown token does no harm', database, async () => {
  const user = await activeUser(), { token } = await identity.authenticate(user.username, PASSWORD);
  await identity.logout(token);
  assert.equal(await identity.session(token), null);
  await identity.logout('unknown-token'); await identity.logout(undefined);
});

test('each role carries exactly its documented permissions, and no principal means no access', database, async () => {
  const permissions = async roles => { const u = await activeUser(roles); return [...(await identity.session((await identity.authenticate(u.username, PASSWORD)).token)).user.permissions].sort(); };
  assert.deepEqual(await permissions(['operator']), ['connection.view', 'resource.operate', 'resource.tag', 'resource.view']);
  assert.deepEqual(await permissions(['auditor']), ['audit.view', 'connection.view', 'resource.view']);
  assert.deepEqual(await permissions(['platform_admin']), ['audit.view', 'connection.manage', 'connection.view', 'identity.manage', 'platform.manage', 'resource.operate', 'resource.tag', 'resource.view']);
  const operator = await identity.session((await identity.authenticate((await activeUser()).username, PASSWORD)).token);
  assert.equal(identity.authorize(operator, 'resource.operate'), true);
  assert.equal(identity.authorize(operator, 'platform.manage'), false);
  assert.equal(identity.authorize(null, 'resource.view'), false);
});

test('users are listed by username with their roles; updates need the current version and change status and roles', database, async () => {
  const { user } = await newUser({ status: 'pending' });
  const listed = await identity.listUsers();
  assert.deepEqual(listed.map(u => u.username.toLowerCase()), listed.map(u => u.username.toLowerCase()).sort());
  assert.equal(listed.find(u => u.id === user.id).status, 'pending');
  await assert.rejects(() => identity.updateUser(user.id, { status: 'active', roles: ['auditor'] }, user.rowVersion + 4), /VERSION_CONFLICT/);
  const activated = await identity.updateUser(user.id, { status: 'active', roles: ['auditor', 'auditor'] }, user.rowVersion);
  assert.deepEqual([activated.status, activated.roles, activated.rowVersion], ['active', ['auditor'], user.rowVersion + 1]);
  assert.ok(await identity.authenticate(user.username, PASSWORD), 'an activated account can sign in');
  for (const bad of [{ status: 'pending', roles: ['operator'] }, { status: 'active', roles: [] }, { status: 'active', roles: ['root'] }, { status: 'bogus', roles: ['operator'] }, { status: 'active', roles: 'operator' }]) {
    await assert.rejects(() => identity.updateUser(user.id, bad, activated.rowVersion), /USER_INVALID/, JSON.stringify(bad));
  }
  assert.equal(await identity.updateUser(randomUUID(), { status: 'active', roles: ['operator'] }, 1), null);
});

test('disabling or locking a user ends their sessions at once; changing only their roles does not', database, async () => {
  const user = await activeUser(), { token } = await identity.authenticate(user.username, PASSWORD);
  const current = (await identity.listUsers()).find(u => u.id === user.id);
  const promoted = await identity.updateUser(user.id, { status: 'active', roles: ['auditor'] }, current.rowVersion);
  const principal = await identity.session(token);
  assert.deepEqual(principal.user.roles, ['auditor'], 'the live session sees the new role straight away');
  await identity.updateUser(user.id, { status: 'disabled', roles: ['auditor'] }, promoted.rowVersion);
  assert.equal(await identity.session(token), null);
  assert.equal(await identity.authenticate(user.username, PASSWORD), null);
});

test('the last active administrator cannot be disabled, locked or demoted; with a second one the first can be', database, async () => {
  const { identity: own } = await isolated();
  const admin = (await own.listUsers()).find(u => u.username === 'admin');
  for (const change of [{ status: 'disabled', roles: ['platform_admin'] }, { status: 'locked', roles: ['platform_admin'] }, { status: 'active', roles: ['operator'] }]) {
    await assert.rejects(() => own.updateUser(admin.id, change, admin.rowVersion), /LAST_ADMIN/, JSON.stringify(change));
  }
  const second = (await own.createUser({ username: 'second.admin', displayName: 'Second', password: PASSWORD, roles: ['platform_admin'] })).user;
  const demoted = await own.updateUser(admin.id, { status: 'active', roles: ['operator'] }, admin.rowVersion);
  assert.deepEqual(demoted.roles, ['operator']);
  const only = (await own.listUsers()).find(u => u.id === second.id);
  await assert.rejects(() => own.updateUser(second.id, { status: 'disabled', roles: ['platform_admin'] }, only.rowVersion), /LAST_ADMIN/, 'now the second one is the last');
});

test('two administrators demoting each other at the same moment must not leave the platform with none', database, async () => {
  let violations = 0;
  for (let round = 0; round < 6; round++) {
    const { identity: own, pool } = await isolated();
    const admin = (await own.listUsers()).find(u => u.username === 'admin');
    const second = (await own.createUser({ username: 'second.admin', displayName: 'Second', password: PASSWORD, roles: ['platform_admin'] })).user;
    await Promise.allSettled([
      own.updateUser(admin.id, { status: 'disabled', roles: ['platform_admin'] }, admin.rowVersion),
      own.updateUser(second.id, { status: 'disabled', roles: ['platform_admin'] }, second.rowVersion)
    ]);
    const remaining = (await pool.query("SELECT count(*)::int AS n FROM identity.users u JOIN identity.user_roles ur ON ur.user_id = u.user_id JOIN identity.roles r ON r.role_id = ur.role_id WHERE u.status = 'active' AND r.normalized_name = 'platform_admin'")).rows[0].n;
    if (remaining === 0) violations++;
  }
  assert.equal(violations, 0, `${violations} of 6 rounds ended with no active administrator`);
});

test('sessions can be listed and revoked, but only by their owner', database, async () => {
  const a = await activeUser(), b = await activeUser();
  const first = await identity.authenticate(a.username, PASSWORD), second = await identity.authenticate(a.username, PASSWORD), other = await identity.authenticate(b.username, PASSWORD);
  const listed = await identity.listSessions(a.id, first.token);
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map(s => s.current).sort(), [false, true]);
  assert.equal(listed.find(s => s.current).id, (await sessionRow(first.token)).session_id_hash);
  assert.equal((await identity.listSessions(b.id, other.token)).length, 1, "another user's sessions are not listed");
  assert.deepEqual(await identity.revokeSession(a.id, 'not-a-hash'), { revoked: 0 });
  assert.deepEqual(await identity.revokeSession(a.id, (await sessionRow(other.token)).session_id_hash), { revoked: 0 }, "cannot revoke someone else's session");
  assert.equal((await identity.session(other.token)).user.id, b.id);
  assert.deepEqual(await identity.revokeSession(a.id, (await sessionRow(second.token)).session_id_hash), { revoked: 1 });
  assert.equal(await identity.session(second.token), null);
  assert.deepEqual(await identity.revokeSessions(a.id), { revoked: 1 }, 'the remaining one');
  assert.deepEqual(await identity.revokeSessions(a.id), { revoked: 0 });
  assert.deepEqual(await identity.listSessions(a.id, null), []);
});

test('recovery codes work once: rotating issues a new code and retires the old, and a reset ends every session', database, async () => {
  const { user, recoveryCode } = await newUser();
  const signedIn = await identity.authenticate(user.username, PASSWORD);
  const rotated = await identity.rotateRecoveryCode(user.id);
  assert.notEqual(rotated.recoveryCode, recoveryCode);
  assert.equal(await identity.resetPassword(user.username, recoveryCode, '12-chars-old-try'), null, 'the retired code no longer works');
  assert.ok(await identity.session(signedIn.token), 'rotating a code does not end sessions');
  const reset = await identity.resetPassword(user.username, `  ${rotated.recoveryCode}  `, '12-chars-after-reset');   // surrounding spaces are tolerated
  assert.ok(reset.recoveryCode && reset.recoveryCode !== rotated.recoveryCode);
  assert.equal(await identity.session(signedIn.token), null, 'a password reset ends the old sessions');
  assert.equal(await identity.resetPassword(user.username, rotated.recoveryCode, '12-chars-again-now'), null, 'a used code cannot be used again');
  await assert.rejects(() => identity.rotateRecoveryCode(randomUUID()), /USER_NOT_FOUND/);
  const pending = await newUser({ status: 'pending' });
  assert.equal(await identity.resetPassword(pending.user.username, pending.recoveryCode, '12-chars-pending-ok'), null, 'a pending account cannot reset');
});

// ---- custom roles ----------------------------------------------------------------------------------------------------------------------------------------------------

test('the built-in roles are in the database with their descriptions, and the catalogue is stored (resource.tag included)', database, async () => {
  const roles = await identity.listRoles();
  const system = roles.filter(role => role.system).map(role => role.name).sort();
  assert.deepEqual(system, ['auditor', 'operator', 'platform_admin']);
  assert.deepEqual(roles.find(role => role.name === 'operator').permissions, ['connection.view', 'resource.operate', 'resource.tag', 'resource.view']);
  assert.ok(roles.filter(role => role.system).every(role => role.description.length > 10));
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM identity.permissions WHERE permission_key='resource.tag'")).rows[0].n, 1);
});

test('custom roles behave the same in PostgreSQL as in memory: create, change with a version, list with the number of holders, and apply at once', database, async () => {
  const name = `tagger_${randomUUID().slice(0, 6)}`;
  const created = await identity.createRole({ name, description: ' tags ', permissions: ['resource.tag', 'resource.view'] });
  assert.deepEqual([created.name, created.description, created.system, created.userCount, created.rowVersion, created.permissions], [name, 'tags', false, 0, 1, ['resource.tag', 'resource.view']]);
  const holder = await activeUser([name]);
  const session = async () => identity.session((await identity.authenticate(holder.username, PASSWORD)).token);
  assert.deepEqual([...(await session()).user.permissions].sort(), ['resource.tag', 'resource.view']);
  assert.equal((await identity.listRoles()).find(role => role.name === name).userCount, 1);
  await assert.rejects(identity.updateRole(name, { permissions: ['resource.view'] }, 7), error => error.message === 'VERSION_CONFLICT');
  const changed = await identity.updateRole(name, { description: 'view', permissions: ['resource.view'] }, 1);
  assert.deepEqual([changed.rowVersion, changed.permissions], [2, ['resource.view']]);
  assert.deepEqual((await session()).user.permissions, ['resource.view']);
  await assert.rejects(identity.createRole({ name, permissions: ['resource.view'] }), error => error.code === 'NUV_ROLE_EXISTS');
  await assert.rejects(identity.deleteRole(name), error => error.code === 'NUV_ROLE_IN_USE');
});

test('PostgreSQL refuses to change or delete a built-in role, and to give a user a role that is not there; an unknown role leaves the user as they were', database, async () => {
  await assert.rejects(identity.updateRole('operator', { permissions: ['resource.view'] }, 1), error => error.code === 'NUV_ROLE_SYSTEM');
  await assert.rejects(identity.deleteRole('platform_admin'), error => error.code === 'NUV_ROLE_SYSTEM');
  assert.equal(await identity.updateRole('no_such_role', { permissions: ['resource.view'] }, 1), null);
  assert.equal(await identity.deleteRole('no_such_role'), null);
  const { user } = await newUser();
  await assert.rejects(identity.updateUser(user.id, { status: 'active', roles: ['operator', 'no_such_role'] }, user.rowVersion), error => error.message === 'USER_INVALID');
  assert.deepEqual((await identity.listUsers()).find(item => item.id === user.id).roles, ['operator'], 'the failed change was rolled back whole');
  await assert.rejects(identity.createUser({ username: `ghost.${randomUUID().slice(0, 6)}`, displayName: 'Ghost', password: PASSWORD, roles: ['no_such_role'] }), error => error.message === 'USER_INVALID');
});

test('a role nobody holds can be deleted, and it is then gone with its permissions; the database rejects a role name that is not well formed', database, async () => {
  const name = `temp_${randomUUID().slice(0, 6)}`;
  const role = await identity.createRole({ name, permissions: ['resource.view'] });
  assert.deepEqual(await identity.deleteRole(name), { deleted: 1 });
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM identity.role_permissions WHERE role_id=$1', [role.id])).rows[0].n, 0);
  await assert.rejects(db.pool.query("INSERT INTO identity.roles(role_id,normalized_name,display_name,is_system) VALUES(gen_random_uuid(),'Bad Name','x',false)"), error => error.code === '23514');
});

test('at most 50 custom roles, even when many are created at the same moment', database, async () => {
  const existing = (await identity.listRoles()).filter(role => !role.system).length;
  const results = await Promise.allSettled(Array.from({ length: 60 - existing }, (_, i) => identity.createRole({ name: `bulk_${randomUUID().slice(0, 8)}_${i}`, permissions: ['resource.view'] })));
  assert.equal((await identity.listRoles()).filter(role => !role.system).length, 50);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'NUV_ROLE_LIMIT'));
});

// ---- two-factor sign-in ----------------------------------------------------------------------------------------------------------------------------------------------

import { totpCode } from '../src/totp.js';
// The same rules as the in-memory tests, against PostgreSQL, with a clock the test moves; plus what only a database can get wrong: simultaneous use of one code, wrong codes that
// must stay counted although the request failed, and the secret at rest.
const time = { now: 1_800_000_000_000 };
const mfa = db ? new PostgresIdentityService(db.pool, { clock: () => time.now }) : null;
const stepCode = (secret, steps = 0) => totpCode(secret, time.now + steps * 30_000);
const mfaFail = expected => error => error.code === expected;
async function mfaUser(roles = ['operator']) {
  const { user } = await mfa.createUser({ username: `mfa.${randomUUID().slice(0, 8)}`, displayName: 'MFA', password: PASSWORD, roles });
  return user;
}
async function mfaLogin(user) {
  const login = await mfa.authenticate(user.username, PASSWORD), principal = await mfa.session(login.token);
  return { token: login.token, id: principal.session.idHash, state: login.mfa.state, userId: user.id };
}
async function mfaEnrolled(user) {
  const who = await mfaLogin(user), started = await mfa.mfaStartEnrollment(user.id, {});
  const { backupCodes } = await mfa.mfaConfirmEnrollment(user.id, who.id, stepCode(started.secret));
  return { who, secret: started.secret, backupCodes };
}

test('PostgreSQL: enrolment needs a correct code; then a new sign-in needs a code that works once, and a backup code works once', database, async () => {
  const user = await mfaUser(), first = await mfaLogin(user);
  assert.equal(first.state, 'verified');
  const started = await mfa.mfaStartEnrollment(user.id, { account: 'ann@example.com' });
  assert.match(started.uri, /^otpauth:\/\/totp\/Nuvrion:ann%40example\.com\?secret=/);
  await assert.rejects(mfa.mfaConfirmEnrollment(user.id, first.id, '000000'), mfaFail('NUV_MFA_CODE_INVALID'));
  assert.equal((await mfa.mfaStatus(user.id)).enrolled, false);
  const { backupCodes } = await mfa.mfaConfirmEnrollment(user.id, first.id, stepCode(started.secret));
  assert.equal(backupCodes.length, 10);
  assert.equal((await mfa.session(first.token)).mfa.state, 'verified');
  assert.deepEqual(await mfa.mfaStatus(user.id), { enrolled: true, enrolledAt: new Date(time.now).toISOString(), backupCodesRemaining: 10, requiredByPolicy: false });
  assert.equal((await mfa.listUsers()).find(item => item.id === user.id).mfaEnrolled, true);
  await assert.rejects(mfa.mfaStartEnrollment(user.id), mfaFail('NUV_MFA_ALREADY_ENROLLED'));
  const second = await mfaLogin(user);
  assert.equal(second.state, 'verification_required');
  await assert.rejects(mfa.mfaVerify(user.id, second.id, { code: stepCode(started.secret) }), mfaFail('NUV_MFA_CODE_INVALID'), 'the enrolling code is spent');
  assert.equal((await mfa.mfaVerify(user.id, second.id, { code: stepCode(started.secret, 1) })).method, 'totp');
  assert.equal((await mfa.session(second.token)).mfa.state, 'verified');
  const third = await mfaLogin(user);
  assert.deepEqual(await mfa.mfaVerify(user.id, third.id, { backupCode: backupCodes[0].toUpperCase().replace('-', ' ') }), { method: 'backup', backupCodesRemaining: 9 });
  const fourth = await mfaLogin(user);
  await assert.rejects(mfa.mfaVerify(user.id, fourth.id, { backupCode: backupCodes[0] }), mfaFail('NUV_MFA_CODE_INVALID'));
  await assert.rejects(mfa.mfaVerify(user.id, fourth.id, { code: 'x'.repeat(65) }), mfaFail('NUV_MFA_REQUEST_INVALID'));
});

test('PostgreSQL: one code used by several sessions at the same moment works for exactly one of them; so does one backup code', database, async () => {
  const user = await mfaUser(), { secret, backupCodes } = await mfaEnrolled(user);
  const sessions = await Promise.all(Array.from({ length: 6 }, () => mfaLogin(user)));
  const code = stepCode(secret, 1), results = await Promise.allSettled(sessions.map(who => mfa.mfaVerify(user.id, who.id, { code })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'a code is good once, even when six sessions try it together');
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'NUV_MFA_CODE_INVALID'));
  time.now += 300_000;
  const more = await Promise.all(Array.from({ length: 6 }, () => mfaLogin(user)));
  const spent = await Promise.allSettled(more.map(who => mfa.mfaVerify(user.id, who.id, { backupCode: backupCodes[3] })));
  assert.equal(spent.filter(result => result.status === 'fulfilled').length, 1, 'and a backup code too');
  assert.equal((await mfa.mfaStatus(user.id)).backupCodesRemaining, 9);
});

test('PostgreSQL: wrong codes are counted although the request failed; five end the sign-in, ten lock the account until the time is up', database, async () => {
  const user = await mfaUser(), { secret } = await mfaEnrolled(user);
  let a = await mfaLogin(user);
  for (let i = 0; i < 4; i++) await assert.rejects(mfa.mfaVerify(user.id, a.id, { code: '000000' }), mfaFail('NUV_MFA_CODE_INVALID'));
  await assert.rejects(mfa.mfaVerify(user.id, a.id, { code: '000000' }), mfaFail('NUV_MFA_SESSION_REVOKED'));
  assert.equal(await mfa.session(a.token), null, 'the fifth wrong code ended the session');
  a = await mfaLogin(user);
  for (let i = 0; i < 4; i++) await assert.rejects(mfa.mfaVerify(user.id, a.id, { code: '111111' }), mfaFail('NUV_MFA_CODE_INVALID'));
  await assert.rejects(mfa.mfaVerify(user.id, a.id, { code: '111111' }), mfaFail('NUV_MFA_SESSION_REVOKED'));
  a = await mfaLogin(user);
  const refused = await mfa.mfaVerify(user.id, a.id, { code: stepCode(secret, 1) }).catch(error => error);
  assert.equal(refused.code, 'NUV_MFA_THROTTLED'); assert.ok(refused.retryAfterSeconds > 890);
  time.now += 901_000;
  assert.equal((await mfa.mfaVerify(user.id, a.id, { code: stepCode(secret) })).method, 'totp');
  const row = (await db.pool.query('SELECT failed_count,locked_until FROM identity.user_mfa WHERE user_id=$1', [user.id])).rows[0];
  assert.deepEqual([row.failed_count, row.locked_until], [0, null], 'a success clears the count');
});

test('PostgreSQL: the policy holds roles to two-factor sign-in at once, and what it names must exist', database, async () => {
  const user = await mfaUser(['auditor']), who = await mfaLogin(user);
  try {
    assert.deepEqual(await mfa.setMfaPolicy(['auditor', 'platform_admin']), { requiredRoles: ['auditor', 'platform_admin'] });
    assert.equal((await mfa.session(who.token)).mfa.state, 'enrollment_required');
    const started = await mfa.mfaStartEnrollment(user.id, {});
    await mfa.mfaConfirmEnrollment(user.id, who.id, stepCode(started.secret));
    assert.equal((await mfa.session(who.token)).mfa.state, 'verified');
    time.now += 30_000;
    await assert.rejects(mfa.mfaDisable(user.id, stepCode(started.secret)), mfaFail('NUV_MFA_REQUIRED_BY_POLICY'));
    assert.equal((await mfa.mfaStatus(user.id)).requiredByPolicy, true);
    await assert.rejects(mfa.setMfaPolicy(['nobody']), mfaFail('NUV_MFA_REQUEST_INVALID'));
    await assert.rejects(mfa.setMfaPolicy('auditor'), mfaFail('NUV_MFA_REQUEST_INVALID'));
    assert.deepEqual(await mfa.getMfaPolicy(), { requiredRoles: ['auditor', 'platform_admin'] }, 'a refused change changed nothing');
  } finally { await mfa.setMfaPolicy([]); }
});

test('PostgreSQL: new backup codes replace the old, turning it off needs a code, and a reset removes the enrolment and ends every session', database, async () => {
  const user = await mfaUser(), { who, secret, backupCodes } = await mfaEnrolled(user);
  time.now += 30_000;
  await assert.rejects(mfa.mfaDisable(user.id, '000000'), mfaFail('NUV_MFA_CODE_INVALID'));
  const fresh = (await mfa.mfaRegenerateBackupCodes(user.id, stepCode(secret))).backupCodes;
  assert.ok(fresh.every(code => !backupCodes.includes(code)));
  const a = await mfaLogin(user);
  await assert.rejects(mfa.mfaVerify(user.id, a.id, { backupCode: backupCodes[0] }), mfaFail('NUV_MFA_CODE_INVALID'));
  assert.equal((await mfa.mfaVerify(user.id, a.id, { backupCode: fresh[0] })).backupCodesRemaining, 9);
  time.now += 30_000;
  assert.deepEqual(await mfa.mfaDisable(user.id, stepCode(secret)), { disabled: true });
  assert.equal((await mfa.mfaStatus(user.id)).enrolled, false);
  const again = await mfaEnrolled(user);
  assert.deepEqual(await mfa.mfaReset(user.id), { reset: true });
  assert.equal(await mfa.session(again.who.token), null);
  assert.equal((await mfa.mfaStatus(user.id)).enrolled, false);
  assert.equal(await mfa.mfaReset(randomUUID()), null);
  assert.ok(who);
});

test('PostgreSQL: the secret is stored encrypted and bound to its user, and the table refuses an enabled row without one', database, async () => {
  const user = await mfaUser(), { secret } = await mfaEnrolled(user), other = await mfaUser();
  const row = (await db.pool.query('SELECT * FROM identity.user_mfa WHERE user_id=$1', [user.id])).rows[0];
  assert.ok(!JSON.stringify(row).includes(secret), 'no plain secret in the row');
  assert.equal(row.secret_cipher.algorithm, 'aes-256-gcm');
  await db.pool.query('INSERT INTO identity.user_mfa(user_id,pending_cipher) VALUES($1,$2)', [other.id, row.secret_cipher]);
  await db.pool.query('UPDATE identity.user_mfa SET secret_cipher=$2 WHERE user_id=$1', [other.id, row.secret_cipher]);
  await db.pool.query('UPDATE identity.user_mfa SET enabled=true WHERE user_id=$1', [other.id]);   // another user's ciphertext: stored, but it will not decrypt for this user
  const login = await mfaLogin(other);
  await assert.rejects(mfa.mfaVerify(other.id, login.id, { code: stepCode(secret) }), error => /Unsupported state|auth/i.test(error.message), 'a ciphertext moved to another user does not decrypt');
  await assert.rejects(db.pool.query("INSERT INTO identity.user_mfa(user_id,enabled) VALUES($1,true)", [(await mfaUser()).id]), error => error.code === '23514');
});
