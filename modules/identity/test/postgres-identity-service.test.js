import test, { after } from 'node:test';
import assert from 'node:assert/strict';
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
