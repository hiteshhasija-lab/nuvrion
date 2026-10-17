# Two-step verification

Two-step verification (two-factor sign-in) means a password is not enough on its own: the person also enters a six-digit code from an authenticator app on their phone. It uses the
standard time-based one-time password (TOTP, RFC 6238: HMAC-SHA-1, 6 digits, 30-second steps), so any authenticator app works: Google Authenticator, Microsoft Authenticator,
1Password, Authy and others.

## For a person

1. **Set it up.** Account menu (top right) → **Two-step verification** → **Set up**. Scan the QR code with the app, or type the key under it. Enter the six-digit code the app now shows and
   choose **Turn on**.
2. **Save the backup codes.** Ten codes are shown **once**. Each signs you in once if you lose your phone. Keep them somewhere safe and apart from your password.
3. **Signing in** then takes two steps: your password, then a code. A code can be typed with or without a space. **Use a backup code instead** is under the field.
4. **Later**, the same dialog shows how many backup codes are left, makes **new backup codes** (the old ones stop working) and **turns two-step verification off**. Both need a current code.

A code works **once**: the next one is a new code (wait for the app to change, up to 30 seconds). A clock a few seconds out is tolerated; check the phone's time if codes are refused.

**Lost your phone?** Sign in with a backup code and set it up again on the new phone. With no backup code left, ask an administrator to reset your two-step verification (below).

## For an administrator

Two-step verification is chosen **per person**. On **Users**, the **Two-step** column of each row says **Not required** or **Required**, and whether the person has it set up; change it and choose **Save**.

- A person for whom it is **Required** and who has not set it up is held at the setup prompt at once, **in a session that is already open too**, and can do nothing else until they do. Nobody else is
  affected. Nobody is locked out by this: setting it up needs only the password they already have.
- Someone for whom it is required **cannot turn it off** (the button says why). Not required: they may use it or not, as they choose.
- **Reset two-step** (in the person's row, shown when they have it set up) removes their enrolment (a lost phone with no backup codes left) and ends their sessions. They sign in with their password and,
  if it is required for them, set it up again: the reset does not change the requirement.
- Requiring it, resetting, and each person's own setup are in the audit history (`identity.mfa_requirement_changed`, `identity.mfa_reset`, `identity.mfa_enrolled`, `identity.mfa_disabled`,
  `identity.mfa_backup_codes_regenerated`, and every code check as `identity.mfa_verified`, with failures). Neither a secret nor a code is ever written to the audit history or the log.

Before 0.1.192 two-step verification was required per role. Anyone who held a role that was required then was carried over as "Required" when 0.1.192 was applied, once; changing a person's setting afterwards
is not undone by later deploys.

### If every administrator is locked out

Another administrator can reset the others. If none can sign in (all lost their phones and backup codes), remove the enrolment from the database on the host, with the database owner role as in
[the restore guide](restore-guide.md), then sign in with the password:

```
DELETE FROM identity.user_mfa WHERE user_id = (SELECT user_id FROM identity.users WHERE normalized_username = 'admin');
UPDATE identity.users SET mfa_required = false WHERE normalized_username = 'admin';   -- only if the requirement itself must be lifted for now
```

## What the platform guarantees

- **Nothing is usable before the second step.** A session that has not finished two-step verification can do nothing but finish it (or sign out): every other call is refused with
  `403 NUV_MFA_REQUIRED`, whatever the person's role allows. The check is in the one place every call passes through, and the host terminal socket refuses such a session as well. The state is
  worked out on every request, so a new requirement or a reset takes effect on the next one.
- **A code is good once.** The last accepted time step is stored, and a code for that step or an earlier one is refused, so a code seen over a shoulder or in a log cannot be replayed. Several
  sessions presenting the same code at the same moment: exactly one succeeds (tested against PostgreSQL). The same holds for each backup code.
- **Guessing is limited.** Five wrong codes end that sign-in (the password is needed again); ten in fifteen minutes lock the account's second step for fifteen minutes, even against a correct code
  (`429 NUV_MFA_THROTTLED` with `Retry-After`). Failures are counted even though the request failed. Requests that are not one code do not count as guesses.
- **Secrets at rest.** The authenticator secret is stored encrypted (AES-256-GCM, with the platform's key ring, bound to the user so it cannot be moved to another account). Backup codes are stored
  only as hashes. The enrolment secret is drawn in the browser as a QR code: it is not sent to any service to be turned into a picture.
- **Enrolling again** (after a reset or turning it off) replaces everything; enrolling ends the verification of the person's *other* sessions, so they must prove the code again.
- **Password reset does not bypass it.** Resetting a password with the lab recovery code still leaves the second step in place at the next sign-in.

The key ring that protects the secrets is the one that protects provider credentials (`NUVRION_ENCRYPTION_KEYS`); it is kept in the configuration archive of every backup. If it were lost, every enrolment
would need an administrator's reset, as lost provider credentials would need re-entering.

## In the API

```
POST   /api/v1/auth/login                      returns "mfa": { "state": "verified" | "verification_required" | "enrollment_required" }; permissions are empty until verified
GET    /api/v1/auth/mfa                        { enrolled, enrolledAt, backupCodesRemaining, required, state }
POST   /api/v1/auth/mfa/verify                 { "code": "123456" }  or  { "backupCode": "abcde-fghjk" }
POST   /api/v1/auth/mfa/enrollment             start: { secret, uri, account, issuer }   (also for a session that must set it up)
POST   /api/v1/auth/mfa/enrollment/confirm     { "code": "123456" } → { backupCodes: [10] }, shown once
POST   /api/v1/auth/mfa/backup-codes           { "code": "123456" } → ten new backup codes
POST   /api/v1/auth/mfa/disable                { "code": "123456" }        refused while a role requires it
PATCH  /api/v1/users/{id}                      { "status": "active", "roles": [...], "mfaRequired": true }   require it for one person   identity.manage
DELETE /api/v1/users/{id}/mfa                  reset a user's enrolment, end their sessions     identity.manage
```

Errors: `NUV_MFA_REQUIRED` (403: not verified yet), `NUV_MFA_CODE_INVALID` and `NUV_MFA_REQUEST_INVALID` (422), `NUV_MFA_SESSION_REVOKED` (401: too many wrong codes), `NUV_MFA_THROTTLED` (429),
`NUV_MFA_ALREADY_ENROLLED`, `NUV_MFA_ENROLLMENT_NOT_STARTED`, `NUV_MFA_NOT_ENROLLED` and `NUV_MFA_REQUIRED_FOR_ACCOUNT` (409).

## How it is kept

`identity.user_mfa` (one row per person: the encrypted secret, a pending secret during setup, the last accepted step, the backup-code hashes, and the failure counters), a `mfa_required` flag on `identity.users` (migration 0036) and two columns on `identity.sessions` (when the session was verified, and its wrong-code count) come with migrations 0035 and 0036.
The role-level policy table of 0035 is left in place, empty and unused.
