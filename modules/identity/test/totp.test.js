import test from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, base32Decode, generateSecret, hotp, totpCode, timeStep, verifyTotp, normaliseCode, otpauthUri, generateBackupCodes, normaliseBackupCode, hashBackupCode, TOTP } from '../src/totp.js';

// The one-time password algorithm against the published test vectors, and the rules around it: one use per code, a small clock tolerance, codes typed with spaces.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));   // the secret used by RFC 4226 and RFC 6238 for SHA-1

test('base32 round-trips and matches the standard encoding', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (const text of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) assert.equal(base32Decode(base32Encode(Buffer.from(text))).toString(), text);
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');                     // RFC 4648 vector (without padding)
  assert.equal(base32Decode('mzxw 6ytb-oi==').toString(), 'foobar', 'spaces, dashes, padding and case are tolerated');
  assert.throws(() => base32Decode('MZXW1'), /NUV_TOTP_SECRET_INVALID/);
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/); assert.equal(base32Decode(secret).length, 20); assert.notEqual(secret, generateSecret());
});

test('HOTP matches the RFC 4226 test vectors', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(hotp(Buffer.from('12345678901234567890'), counter), code, `counter ${counter}`));
});

test('TOTP matches the RFC 6238 test vectors (SHA-1, shown as 6 digits)', () => {
  for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(totpCode(RFC_SECRET, seconds * 1000), code, `t=${seconds}`);
  }
});

test('a code is accepted for this step and one either side, not further, and each step only once', () => {
  const now = 1_700_000_000_000, step = timeStep(now), code = at => totpCode(RFC_SECRET, at);
  assert.deepEqual(verifyTotp(RFC_SECRET, code(now), { timeMs: now }), { ok: true, step });
  assert.equal(verifyTotp(RFC_SECRET, code(now - 30_000), { timeMs: now }).step, step - 1, 'the step before: a clock running slow');
  assert.equal(verifyTotp(RFC_SECRET, code(now + 30_000), { timeMs: now }).step, step + 1, 'the step after: a clock running fast');
  assert.equal(verifyTotp(RFC_SECRET, code(now - 90_000), { timeMs: now }).ok, false, 'three steps out is refused');
  assert.equal(verifyTotp(RFC_SECRET, code(now + 90_000), { timeMs: now }).ok, false);
  assert.equal(verifyTotp(RFC_SECRET, code(now), { timeMs: now, lastStep: step }).ok, false, 'the same code twice: refused');
  assert.equal(verifyTotp(RFC_SECRET, code(now - 30_000), { timeMs: now, lastStep: step }).ok, false, 'and so is an older one once a newer is used');
  assert.equal(verifyTotp(RFC_SECRET, code(now + 30_000), { timeMs: now, lastStep: step }).ok, true, 'a later step still works');
});

test('what is not a code is refused without comparing anything', () => {
  for (const bad of [undefined, null, '', '12345', '1234567', 'abcdef', '12 34 5', 12345.6, {}, [], '１２３４５６']) assert.equal(verifyTotp(RFC_SECRET, bad, { timeMs: 59_000 }).ok, false, String(bad));
  assert.equal(normaliseCode(' 287 082 '), '287082');
  assert.equal(normaliseCode('287-082'), '287082');
  assert.equal(verifyTotp(RFC_SECRET, '287 082', { timeMs: 59_000 }).ok, true, 'a code typed in groups is accepted');
});

test('the enrolment link carries the secret, the issuer and the standard parameters', () => {
  const uri = otpauthUri({ secret: 'ABCDEFGH', account: 'ann@example.com' });
  assert.equal(uri, 'otpauth://totp/Nuvrion:ann%40example.com?secret=ABCDEFGH&issuer=Nuvrion&algorithm=SHA1&digits=6&period=30');
  assert.ok(otpauthUri({ secret: 'A', account: 'a b/c&d' }).includes('a%20b%2Fc%26d'), 'the account name cannot add parameters');
  assert.equal(TOTP.digits, 6);
});

test('backup codes are ten, distinct, unambiguous, typed any way, and stored only as hashes', () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  for (const code of codes) { assert.match(code, /^[a-z2-9]{5}-[a-z2-9]{5}$/); assert.doesNotMatch(code, /[ilo01]/); }
  const code = codes[0], normalised = normaliseBackupCode(code);
  assert.equal(normalised, code.replace('-', ''));
  assert.equal(normaliseBackupCode(` ${code.toUpperCase()} `), normalised);
  assert.equal(normaliseBackupCode(code.replace('-', ' ')), normalised);
  for (const bad of [undefined, '', 'short', 'abcde-abcd', 'abcde-abcdeX', 'ilo01-ilo01', 'ab\u0000de-abcde']) assert.equal(normaliseBackupCode(bad), null, String(bad));
  assert.match(hashBackupCode(normalised), /^[0-9a-f]{64}$/);
  assert.notEqual(hashBackupCode(normalised), hashBackupCode(normaliseBackupCode(codes[1])));
  assert.equal(hashBackupCode(normalised), hashBackupCode(normaliseBackupCode(code.toUpperCase())));
});
