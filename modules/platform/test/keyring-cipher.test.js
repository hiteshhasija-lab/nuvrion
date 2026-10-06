import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyringCipher, KeyringConfigurationError, keyringFromEnvironment } from '../src/keyring-cipher.js';

const secret = { username: 'root', password: 'p@ss "quoted" é', nested: { a: [1, 2, 3] } };
const ring = (active = 'k1', keys = { k1: 'first-key-material', k2: 'second-key-material' }) => new KeyringCipher({ activeKeyId: active, keys });

test('a value round-trips through encrypt and decrypt', () => {
  const cipher = ring();
  const sealed = cipher.encrypt(secret);
  assert.equal(sealed.algorithm, 'aes-256-gcm');
  assert.equal(sealed.keyId, 'k1');
  assert.deepEqual(cipher.decrypt(sealed), secret);
});

test('ciphertext does not contain the plaintext and every encryption uses a fresh nonce', () => {
  const cipher = ring();
  const a = cipher.encrypt(secret), b = cipher.encrypt(secret);
  assert.equal(a.ciphertext.toString('utf8').includes('root'), false);
  assert.notDeepEqual(a.nonce, b.nonce);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
});

test('any tampering with the ciphertext, tag or nonce is detected', () => {
  const cipher = ring(), sealed = cipher.encrypt(secret);
  const flip = buffer => { const copy = Buffer.from(buffer); copy[0] ^= 0x01; return copy; };
  assert.throws(() => cipher.decrypt({ ...sealed, ciphertext: flip(sealed.ciphertext) }));
  assert.throws(() => cipher.decrypt({ ...sealed, tag: flip(sealed.tag) }));
  assert.throws(() => cipher.decrypt({ ...sealed, nonce: flip(sealed.nonce) }));
});

test('the context is authenticated: a secret cannot be decrypted for a different purpose', () => {
  const cipher = ring(), sealed = cipher.encrypt(secret, { context: 'nuvrion:connection-a' });
  assert.deepEqual(cipher.decrypt(sealed, { context: 'nuvrion:connection-a' }), secret);
  assert.throws(() => cipher.decrypt(sealed, { context: 'nuvrion:connection-b' }));
  assert.throws(() => cipher.decrypt(sealed));
});

test('rotation: old secrets stay readable while new ones use the new active key', () => {
  const before = ring('k1').encrypt(secret);
  const rotated = ring('k2');
  assert.deepEqual(rotated.decrypt(before), secret, 'a retired key still decrypts old data');
  assert.equal(rotated.encrypt(secret).keyId, 'k2');
});

test('a secret sealed with a key that is no longer in the ring cannot be read', () => {
  const sealed = ring('k1').encrypt(secret);
  const without = new KeyringCipher({ activeKeyId: 'k2', keys: { k2: 'second-key-material' } });
  assert.throws(() => without.decrypt(sealed), /NUV_ENCRYPTION_KEY_UNAVAILABLE/);
});

test('an unsupported algorithm is refused', () => {
  const cipher = ring(), sealed = cipher.encrypt(secret);
  assert.throws(() => cipher.decrypt({ ...sealed, algorithm: 'aes-128-cbc' }), /NUV_CIPHERTEXT_ALGORITHM_UNSUPPORTED/);
});

test('a different key ring cannot read the data', () => {
  const sealed = ring('k1', { k1: 'first-key-material' }).encrypt(secret);
  assert.throws(() => new KeyringCipher({ activeKeyId: 'k1', keys: { k1: 'a-different-key' } }).decrypt(sealed));
});

test('invalid key ring configuration is rejected', () => {
  assert.throws(() => new KeyringCipher({ activeKeyId: '', keys: { k1: 'x' } }), KeyringConfigurationError);
  assert.throws(() => new KeyringCipher({ activeKeyId: 'k1', keys: {} }), KeyringConfigurationError);
  assert.throws(() => new KeyringCipher({ activeKeyId: 'missing', keys: { k1: 'x' } }), KeyringConfigurationError);
});

test('environment: a configured key ring is used, malformed JSON is rejected', () => {
  const env = { NUVRION_ENCRYPTION_KEYS: JSON.stringify({ a: 'one', b: 'two' }), NUVRION_ACTIVE_ENCRYPTION_KEY_ID: 'b' };
  assert.equal(keyringFromEnvironment(env).activeKeyId, 'b');
  assert.throws(() => keyringFromEnvironment({ NUVRION_ENCRYPTION_KEYS: '{not json' }), /valid JSON/);
});

test('environment: production refuses to fall back to the development key; development may', () => {
  assert.throws(() => keyringFromEnvironment({}, { production: true }), KeyringConfigurationError);
  assert.equal(keyringFromEnvironment({}, { production: false }).activeKeyId, 'local-development-key');
});
