import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';
import { hashPassword, passwordMatches, needsPasswordRehash } from '../src/password-hasher.js';

test('new hashes use Argon2id with the documented cost and a random salt', () => {
  const a = hashPassword('correct horse battery staple'), b = hashPassword('correct horse battery staple');
  assert.match(a, /^argon2id\$19456\$2\$1\$[\w-]+\$[\w-]+$/);
  assert.notEqual(a, b, 'two hashes of the same password must differ');
});

test('the right password matches and wrong ones do not', () => {
  const stored = hashPassword('S3cure-Passphrase!');
  assert.equal(passwordMatches('S3cure-Passphrase!', stored), true);
  assert.equal(passwordMatches('s3cure-passphrase!', stored), false);
  assert.equal(passwordMatches('', stored), false);
  assert.equal(passwordMatches('S3cure-Passphrase! ', stored), false);
});

test('a freshly created hash does not need rehashing', () => {
  assert.equal(needsPasswordRehash(hashPassword('x')), false);
});

test('legacy scrypt hashes still verify and are flagged for upgrade', () => {
  const salt = randomBytes(16), hash = scryptSync('legacy-password', salt, 32, { N: 16384, r: 8, p: 1 });
  const legacy = `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
  assert.equal(passwordMatches('legacy-password', legacy), true);
  assert.equal(passwordMatches('other', legacy), false);
  assert.equal(needsPasswordRehash(legacy), true);
});

test('weaker Argon2id parameters are flagged for upgrade', () => {
  assert.equal(needsPasswordRehash('argon2id$4096$1$1$c2FsdA$aGFzaA'), true);
});

test('malformed or unknown stored values never match and never throw', () => {
  for (const bad of [null, undefined, '', 'garbage', 'argon2id$x', 'md5$1$2$3$a$b', 'argon2id$19456$2$1$$']) {
    assert.equal(passwordMatches('anything', bad), false, String(bad));
  }
});
