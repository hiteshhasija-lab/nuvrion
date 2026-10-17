# Users and passwords

Every person who uses Nuvrion has an account: a username, a display name, a password, one or more [roles](roles.md) and, optionally, [two-step verification](mfa.md). Administrators (anyone with
the `identity.manage` permission) manage accounts on the **Users** page.

## Creating a user

**Users → + New user.** Enter a username and a display name, choose a role, and give the person a first password (type one, or **Generate** a 16-character one that is easy to read out). Two options:

- **Ask them to choose their own password the first time they sign in** (on by default). The person signs in with the first password and is held at "Choose a new password" before they can do
  anything else; the first password then stops working. The administrator therefore knows it only for as long as it takes to pass it on.
- **Require two-step verification for this person** (off by default): see [mfa.md](mfa.md).

The account is active as soon as it is created. The next screen shows the username and password **once**, with a button to copy them; pass them on yourself (in person, by phone, in a password
manager), not by e-mail if you can avoid it. The password is never shown again and is never written to the audit history or the log.

Rules: a username is 3 to 128 letters, digits, dots, hyphens or underscores, and is unique whatever the case; a display name is up to 200 characters; a password has at least 12 characters; the role
must exist. You can only give a user a role whose permissions you hold yourself, so an administrator-in-name who holds only `identity.manage` cannot create an administrator.

(People can also ask for an account themselves on the sign-in page when the lab sign-up mode is on; they appear as *pending* and an administrator approves them with **Approve**.)

## Passwords

- **A person changes their own:** account menu (top right) → **Change password**. It needs the current password and a new one (12 or more characters, different from the current one). Their *other*
  sessions are signed out; the one they are using carries on. A wrong current password counts against a limit (five in a few minutes), so a session left open cannot be used to guess it.
- **A forgotten password:** **Users →** the person's row **→ Set password.** The administrator sets a temporary password; every session of that person ends, and by default they choose their own at
  next sign-in. An administrator cannot do this for their own account (use **Change password**), so the one account that can always sign in is never replaced from under its owner.
- **Resetting a password does not bypass two-step verification:** the second step is still asked for at the next sign-in.
- A person who has not yet chosen their password sees nothing of the console and can use nothing except the call that changes it, finishing two-step verification and signing out: every other call is
  refused with `403 NUV_PASSWORD_CHANGE_REQUIRED`, whatever their role allows.

## In the API

```
POST /api/v1/users                      { username, displayName, password, roles: [...], mfaRequired?, mustChangePassword? (default true) }   → 201 the user       identity.manage
POST /api/v1/users/{id}/password        { password, mustChange? (default true) }      ends the person's sessions                                                   identity.manage
POST /api/v1/auth/password              { currentPassword, newPassword }              ends your other sessions
PATCH /api/v1/users/{id}                { status, roles, mfaRequired? }                                                                                              identity.manage
```

The sign-in and `/auth/me` responses carry `passwordChangeRequired`; a user carries `mustChangePassword`. Errors: `NUV_USER_INVALID`, `NUV_PASSWORD_TOO_SHORT`, `NUV_PASSWORD_INCORRECT`,
`NUV_PASSWORD_UNCHANGED` (422), `NUV_USERNAME_EXISTS`, `NUV_PASSWORD_USE_OWN_CHANGE` (409), `NUV_ROLE_ESCALATION` (403), `NUV_PASSWORD_THROTTLED` (429), `NUV_PASSWORD_CHANGE_REQUIRED` (403).
Creating a user, changing a password (including refused attempts) and setting a temporary one are in the audit history (`identity.user_created`, `identity.password_changed`, `identity.password_set`).

## How it is kept

Passwords are stored as salted hashes only. `identity.users.must_change_password` (migration 0037) is the flag behind "choose a new password"; it is cleared when the person changes their password.
