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

**Users** has a panel **Two-step verification**: tick the roles whose holders must use it and **Save**. The built-in roles can be named (for example `platform_admin`).

- It applies **at once, to sessions already open**: a holder who has not set it up is held at the setup prompt until they do, and can do nothing else. No one is locked out by this: setting it
  up needs only the password they already have.
- Someone whose role requires it **cannot turn it off** (the button says why).
- The user list shows who has it ("2-step on"). **Reset two-step** removes a person's enrolment (a lost phone with no backup codes left) and ends their sessions; they sign in with their
  password and, if their role requires it, set it up again. The reset is in the audit history.
- Changing the policy is audited (`identity.mfa_policy_changed`), as are enrolling, turning it off, new backup codes, every code check (`identity.mfa_verified`, with failures), and resets. Neither
  a secret nor a code is ever written to the audit history or the log.

### If every administrator is locked out

Another administrator can reset the others. If none can sign in (all lost their phones and backup codes), remove the enrolment from the database on the host, with the database owner role as in
[the restore guide](restore-guide.md), then sign in with the password:

```
DELETE FROM identity.user_mfa WHERE user_id = (SELECT user_id FROM identity.users WHERE normalized_username = 'admin');
UPDATE identity.mfa_policy SET required_roles = '{}' WHERE policy_id = 1;   -- only if the policy itself must be lifted for now
```

## What the platform guarantees

- **Nothing is usable before the second step.** A session that has not finished two-step verification can do nothing but finish it (or sign out): every other call is refused with
  `403 NUV_MFA_REQUIRED`, whatever the person's role allows. The check is in the one place every call passes through, and the host terminal socket refuses such a session as well. The state is
  worked out on every request, so a new policy or a reset takes effect on the next one.
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
GET    /api/v1/auth/mfa                        { enrolled, enrolledAt, backupCodesRemaining, requiredByPolicy, state }
POST   /api/v1/auth/mfa/verify                 { "code": "123456" }  or  { "backupCode": "abcde-fghjk" }
POST   /api/v1/auth/mfa/enrollment             start: { secret, uri, account, issuer }   (also for a session that must set it up)
POST   /api/v1/auth/mfa/enrollment/confirm     { "code": "123456" } → { backupCodes: [10] }, shown once
POST   /api/v1/auth/mfa/backup-codes           { "code": "123456" } → ten new backup codes
POST   /api/v1/auth/mfa/disable                { "code": "123456" }        refused while a role requires it
GET    /api/v1/mfa-policy                      { requiredRoles: [...] }                         identity.manage
PUT    /api/v1/mfa-policy                      { "requiredRoles": ["platform_admin"] }          identity.manage
DELETE /api/v1/users/{id}/mfa                  reset a user's enrolment, end their sessions     identity.manage
```

Errors: `NUV_MFA_REQUIRED` (403: not verified yet), `NUV_MFA_CODE_INVALID` and `NUV_MFA_REQUEST_INVALID` (422), `NUV_MFA_SESSION_REVOKED` (401: too many wrong codes), `NUV_MFA_THROTTLED` (429),
`NUV_MFA_ALREADY_ENROLLED`, `NUV_MFA_ENROLLMENT_NOT_STARTED`, `NUV_MFA_NOT_ENROLLED` and `NUV_MFA_REQUIRED_BY_POLICY` (409).

## How it is kept

`identity.user_mfa` (one row per person: the encrypted secret, a pending secret during setup, the last accepted step, the backup-code hashes, and the failure counters), `identity.mfa_policy` (a single
row naming the roles) and two columns on `identity.sessions` (when the session was verified, and its wrong-code count) come with migration 0035. Roles themselves are not changed by the policy, so the
built-in ones, which cannot be edited, can be named in it.
