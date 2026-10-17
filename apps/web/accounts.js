// Accounts and passwords in the console (docs/users.md): the dialogs that create an account, set a temporary password, and let a person change their own, including the one that
// holds a person at "choose a new password" before anything else. Pure functions, kept apart from app.js so they can be tested in node; app.js passes in `esc` and puts the HTML
// in the page. The server decides what is valid (12 characters, an existing role, a free username); what is checked here only saves a round trip.

export const MIN_PASSWORD = 12;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';   // no 0/O, 1/l/I: it will be read out or typed by hand

// Sixteen characters in groups of four (about 90 bits); `randomInt(n)` returns an integer below n (the browser's crypto in the page, a stub in tests).
export function generatePassword(randomInt) {
  const chars = Array.from({ length: 16 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]);
  return [0, 4, 8, 12].map(at => chars.slice(at, at + 4).join('')).join('-');
}

const errorBox = (error, { esc }) => `<p id="account-error" class="tag-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>`;
const header = (title, { esc, eyebrow = 'ACCOUNT', close = true }) => `<header><div><p class="eyebrow">${esc(eyebrow)}</p><h2 id="account-title">${esc(title)}</h2></div>${close ? '<button id="account-close" type="button">Close</button>' : ''}</header>`;

// ---- an administrator creates an account -------------------------------------------------------------------------------------------------------------------------------
export function newUserHtml({ roles, password = '', error = '', defaults = {} }, { esc, roleLabel = role => role.displayName ?? role.name }) {
  const chosen = defaults.role ?? (roles.some(role => role.name === 'operator') ? 'operator' : roles[0]?.name);
  const options = roles.map(role => `<option value="${esc(role.name)}"${role.name === chosen ? ' selected' : ''}>${esc(roleLabel(role))}</option>`).join('');
  return `${header('New user', { esc })}<p class="tag-help">The account is active as soon as you create it. You choose its first password and pass it on yourself; by default the person is asked to choose their own the first time they sign in.</p>
<section class="tag-fields"><label>Username<input id="account-username" name="username" autocomplete="off" spellcheck="false" maxlength="128" required placeholder="ann.example"></label><label>Display name<input id="account-display-name" name="displayName" autocomplete="off" maxlength="200" required placeholder="Ann Example"></label></section>
<section class="tag-fields"><label>Role<select id="account-role" name="role">${options}</select></label><label>First password<span class="account-password-row"><input id="account-password" name="password" type="text" autocomplete="off" spellcheck="false" minlength="${MIN_PASSWORD}" required value="${esc(password)}"><button id="account-generate" type="button">Generate</button></span></label></section>
<label class="account-check"><input id="account-must-change" name="mustChangePassword" type="checkbox"${defaults.mustChange === false ? '' : ' checked'}><span>Ask them to choose their own password the first time they sign in</span></label>
<label class="account-check"><input id="account-mfa" name="mfaRequired" type="checkbox"${defaults.mfaRequired ? ' checked' : ''}><span>Require two-step verification for this person</span></label>
<p class="tag-help">At least ${MIN_PASSWORD} characters. A username uses letters, digits, dots, hyphens and underscores.</p>${errorBox(error, { esc })}<button id="account-submit" type="submit" class="primary">Create user</button>`;
}

// What the administrator passes on, shown once.
export function credentialsHtml({ title, username, password, mustChange, note }, { esc }) {
  return `${header(title, { esc })}<p class="tag-help">${esc(note)}</p><dl class="mfa-facts"><dt>Username</dt><dd><code id="account-created-username">${esc(username)}</code></dd><dt>Password</dt><dd><code id="account-created-password">${esc(password)}</code></dd><dt>At first sign-in</dt><dd>${mustChange ? 'They choose their own password' : 'They may keep this one'}</dd></dl><p class="mfa-links"><button type="button" data-account-copy>Copy username and password</button></p><button id="account-done" type="button" class="primary">Done</button>`;
}

export function setPasswordHtml({ user, password = '', error = '' }, { esc }) {
  return `${header(`Set a password for ${user.displayName}`, { esc })}<p class="tag-help">Use this when ${esc(user.username)} has forgotten their password. Every session of theirs ends, and by default they choose their own password when they next sign in. You pass the new one on yourself.</p>
<label>New password<span class="account-password-row"><input id="account-password" name="password" type="text" autocomplete="off" spellcheck="false" minlength="${MIN_PASSWORD}" required value="${esc(password)}"><button id="account-generate" type="button">Generate</button></span></label>
<label class="account-check"><input id="account-must-change" name="mustChange" type="checkbox" checked><span>Ask them to choose their own password when they next sign in</span></label>
<p class="tag-help">At least ${MIN_PASSWORD} characters.</p>${errorBox(error, { esc })}<button id="account-submit" type="submit" class="primary">Set password</button>`;
}

// ---- a person changes their own password -------------------------------------------------------------------------------------------------------------------------------
export function changePasswordHtml({ gate = false, error = '' }, { esc }) {
  const intro = gate ? 'An administrator set your first password, so you need to choose your own before you continue.' : 'Choose a new password. Your other sessions are signed out; this one carries on.';
  const links = gate ? '<p class="mfa-links"><button type="button" class="text-button" data-account-cancel>Cancel and sign out</button></p>' : '';
  return `${header(gate ? 'Choose a new password' : 'Change password', { esc, close: !gate })}<p class="tag-help">${esc(intro)}</p>
<label class="mfa-field">Current password<input id="account-current" name="currentPassword" type="password" autocomplete="current-password" required></label>
<label class="mfa-field">New password<input id="account-new" name="newPassword" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
<label class="mfa-field">New password again<input id="account-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
<p class="tag-help">At least ${MIN_PASSWORD} characters, and different from the current one.</p>${errorBox(error, { esc })}<button id="account-submit" type="submit" class="primary">${gate ? 'Continue' : 'Change password'}</button>${links}`;
}

// Checks that only save a round trip; null when fine.
export function changePasswordProblem({ currentPassword, newPassword, confirmPassword }) {
  if (!currentPassword) return 'Enter your current password.';
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) return `The new password needs at least ${MIN_PASSWORD} characters.`;
  if (newPassword !== confirmPassword) return 'The two new passwords are not the same.';
  if (newPassword === currentPassword) return 'Choose a password different from the current one.';
  return null;
}

export const newUserBody = ({ username, displayName, role, password, mustChangePassword, mfaRequired }) => ({ username: username.trim(), displayName: displayName.trim(), password, roles: [role], mustChangePassword: Boolean(mustChangePassword), mfaRequired: Boolean(mfaRequired) });
export const copyText = ({ username, password }) => `Username: ${username}\nPassword: ${password}`;
