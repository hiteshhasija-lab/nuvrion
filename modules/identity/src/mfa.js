// Two-factor sign-in rules (docs/mfa.md), shared by both stores (the local one and PostgreSQL) and the API, so they cannot disagree about what a code is worth.
//
// A signed-in session is in one of three states: "verified" (nothing more is needed), "verification_required" (the person has an authenticator and has not yet proved they hold
// it in this session) or "enrollment_required" (their role needs two-factor sign-in and they have none set up yet). Only a verified session may do anything but finish
// signing in. The state is worked out on every request from the person's enrolment, the policy and the session, so a change to the policy or an administrator's reset applies at once.

import { verifyTotp, normaliseBackupCode, hashBackupCode } from './totp.js';

export const MFA_LIMITS = Object.freeze({ sessionFailures: 5, userFailures: 10, windowMs: 15 * 60_000, lockMs: 15 * 60_000 });
export const MFA_STATES = Object.freeze(['verified', 'verification_required', 'enrollment_required']);

export class MfaError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
export const MFA_ERRORS = Object.freeze({
  invalid: () => new MfaError('That code is not right. Check the time on your device, or use a backup code.', 'NUV_MFA_CODE_INVALID'),
  throttled: retryAfterSeconds => Object.assign(new MfaError('Too many wrong codes. Try again later.', 'NUV_MFA_THROTTLED'), { retryAfterSeconds }),
  sessionRevoked: () => new MfaError('Too many wrong codes: this sign-in was ended. Sign in again.', 'NUV_MFA_SESSION_REVOKED'),
  alreadyEnrolled: () => new MfaError('Two-factor sign-in is already set up. Turn it off first to set it up again.', 'NUV_MFA_ALREADY_ENROLLED'),
  notStarted: () => new MfaError('Start setting up two-factor sign-in first.', 'NUV_MFA_ENROLLMENT_NOT_STARTED'),
  notEnrolled: () => new MfaError('Two-factor sign-in is not set up.', 'NUV_MFA_NOT_ENROLLED'),
  requiredByPolicy: () => new MfaError('Your role requires two-factor sign-in, so it cannot be turned off.', 'NUV_MFA_REQUIRED_BY_POLICY'),
  invalidRequest: message => new MfaError(message, 'NUV_MFA_REQUEST_INVALID')
});

export const requiresMfa = (roles, requiredRoles) => roles.some(role => requiredRoles.includes(role));

export function stateFor({ enrolled, verified, required }) {
  if (enrolled) return verified ? 'verified' : 'verification_required';
  return required ? 'enrollment_required' : 'verified';
}

// ---- failures --------------------------------------------------------------------------------------------------------------------------------------------------------
// record: { failedCount, failedSince (ms or null), lockedUntil (ms or null) }
export const lockedFor = (record, now) => (record.lockedUntil && record.lockedUntil > now ? Math.ceil((record.lockedUntil - now) / 1000) : 0);

export function afterFailure(record, now) {
  const fresh = !record.failedSince || now - record.failedSince > MFA_LIMITS.windowMs;
  const failedCount = (fresh ? 0 : record.failedCount) + 1, failedSince = fresh ? now : record.failedSince;
  return { failedCount, failedSince, lockedUntil: failedCount >= MFA_LIMITS.userFailures ? now + MFA_LIMITS.lockMs : record.lockedUntil ?? null };
}
export const afterSuccess = () => ({ failedCount: 0, failedSince: null, lockedUntil: null });

// ---- a code ----------------------------------------------------------------------------------------------------------------------------------------------------------
// input: { code } or { backupCode }, exactly one, as strings. Returns { ok, method, step?, consumed? } without changing anything; the store applies the result atomically.
export function checkInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw MFA_ERRORS.invalidRequest('The request must be a JSON object.');
  const given = ['code', 'backupCode'].filter(key => input[key] !== undefined);
  if (given.length !== 1 || typeof input[given[0]] !== 'string') throw MFA_ERRORS.invalidRequest('Give either code or backupCode, as text.');
  if (input[given[0]].length > 64) throw MFA_ERRORS.invalidRequest('That is too long to be a code.');
  return given[0];
}

export function evaluate({ secret, lastStep = 0, backupHashes = [] }, input, now = Date.now()) {
  const kind = checkInput(input);
  if (kind === 'backupCode') {
    const normalised = normaliseBackupCode(input.backupCode);
    if (!normalised) return { ok: false };
    const hash = hashBackupCode(normalised);
    return backupHashes.includes(hash) ? { ok: true, method: 'backup', consumed: hash } : { ok: false };
  }
  const result = verifyTotp(secret, input.code, { timeMs: now, lastStep });
  return result.ok ? { ok: true, method: 'totp', step: result.step } : { ok: false };
}

export function validatePolicyRoles(raw, knownRoles) {
  if (!Array.isArray(raw) || raw.some(role => typeof role !== 'string')) throw MFA_ERRORS.invalidRequest('requiredRoles must be a list of role names.');
  const unknown = raw.find(role => !knownRoles.includes(role));
  if (unknown !== undefined) throw MFA_ERRORS.invalidRequest(`Unknown role: ${unknown.slice(0, 60)}.`);
  return knownRoles.filter(role => raw.includes(role));
}
