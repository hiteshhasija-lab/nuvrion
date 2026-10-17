// Time-based one-time passwords (RFC 6238) and backup codes, for two-factor sign-in (docs/mfa.md). Standard parameters (HMAC-SHA-1, 6 digits, 30-second steps) so any
// authenticator app works. Pure functions over node:crypto; the stores decide where secrets live and the service decides what to do with a result.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOTP = Object.freeze({ digits: 6, periodSeconds: 30, window: 1, secretBytes: 20, issuer: 'Nuvrion', backupCodes: 10 });
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]*$/.test(clean)) throw new Error('NUV_TOTP_SECRET_INVALID');
  let bits = 0, value = 0; const out = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(TOTP.secretBytes));

export function hotp(secretBytes, counter, digits = TOTP.digits) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secretBytes).update(message).digest(), offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (timeMs, period = TOTP.periodSeconds) => Math.floor(timeMs / 1000 / period);
export const totpCode = (secret, timeMs = Date.now()) => hotp(base32Decode(secret), timeStep(timeMs));

const sameText = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// A code as a person types it: digits, possibly in groups ("123 456"). Anything else is not a code.
export function normaliseCode(raw) {
  const text = String(raw ?? '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(text) ? text : null;                       // TOTP.digits, written out: the pattern is not built from data
}

// Whether `code` is the code for the current step or one step either side (a clock a few seconds out), and has not been used already: a step at or below `lastStep` is
// refused, so one code works once. Returns { ok, step }; the caller stores `step` as the new lastStep when ok.
export function verifyTotp(secret, code, { timeMs = Date.now(), lastStep = 0, window = TOTP.window } = {}) {
  const wanted = normaliseCode(code);
  if (!wanted) return { ok: false, step: null };
  const bytes = base32Decode(secret), now = timeStep(timeMs);
  let matched = null;
  for (let step = now - window; step <= now + window; step++) {
    if (step > 0 && sameText(hotp(bytes, step), wanted) && matched === null) matched = step;   // every step is compared, so the time taken does not say which one matched
  }
  return matched !== null && matched > lastStep ? { ok: true, step: matched } : { ok: false, step: null };
}

export function otpauthUri({ secret, account, issuer = TOTP.issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP.digits}&period=${TOTP.periodSeconds}`;
}

// ---- backup codes --------------------------------------------------------------------------------------------------------------------------------------------------
// Ten one-time codes of ten characters from an alphabet without look-alikes (50 bits each), shown once as "xxxxx-xxxxx". Only a hash of each is kept.
const BACKUP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateBackupCodes(count = TOTP.backupCodes) {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export function normaliseBackupCode(raw) {
  const text = String(raw ?? '').toLowerCase().replace(/[\s-]/g, '');
  return /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/.test(text) ? text : null;   // BACKUP_ALPHABET, written out
}

export const hashBackupCode = normalised => createHash('sha256').update(`nuvrion:backup:${normalised}`).digest('hex');
