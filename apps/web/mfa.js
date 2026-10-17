// Two-step verification in the console (docs/mfa.md): the dialog that asks for a code at sign-in, sets an authenticator up, shows the backup codes and manages them, and the
// policy panel on the Users page. Pure functions, kept apart from app.js so they can be tested in node; app.js passes in `esc` and puts the HTML in the page. The server
// (modules/identity/src/mfa.js) decides what a code is worth; nothing here is a security check, it only asks well and says what happened.

import { qrSvg } from './qr.js';

export const groupSecret = secret => String(secret).replace(/(.{4})(?=.)/g, '$1 ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errorBox = (error, { esc }) => `<p id="mfa-error" class="tag-error" role="alert"${error ? '' : ' hidden'}>${esc(error)}</p>`;
const header = (title, { esc, eyebrow = 'TWO-STEP VERIFICATION', close = false }) => `<header><div><p class="eyebrow">${esc(eyebrow)}</p><h2 id="mfa-title">${esc(title)}</h2></div>${close ? '<button id="mfa-close" type="button">Close</button>' : ''}</header>`;

// The code prompt at sign-in (gate) or before a sensitive action (the action's own button text goes in `submit`).
export function verifyHtml({ backup = false, error = '', gate = true, submit = 'Verify', intro }, { esc }) {
  const help = intro ?? (backup ? 'Enter one of your backup codes. Each one works once.' : 'Open your authenticator app and enter the 6-digit code it shows for Nuvrion.');
  const input = backup
    ? '<input id="mfa-code" name="code" autocomplete="off" spellcheck="false" maxlength="16" required>'
    : '<input id="mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]*" required>';
  const links = gate
    ? `<p class="mfa-links"><button type="button" class="text-button" data-mfa-toggle-backup>${backup ? 'Use the code from my app instead' : 'Use a backup code instead'}</button><button type="button" class="text-button" data-mfa-cancel>Cancel and sign out</button></p>`
    : '<p class="mfa-links"><button type="button" class="text-button" data-mfa-back>Back</button></p>';
  return `${header(gate ? 'Enter your code' : 'Confirm with a code', { esc })}<p class="tag-help">${esc(help)}</p><label class="mfa-field">${backup ? 'Backup code' : 'Code'}${input}</label>${errorBox(error, { esc })}<button id="mfa-submit" type="submit" class="primary">${esc(submit)}</button>${links}`;
}

// Setting up: the QR code (drawn here, so the secret goes nowhere else), the same secret to type, and a code to prove the app has it.
export function setupHtml({ secret, uri, account, error = '', gate = false }, { esc }) {
  let picture;
  try { picture = qrSvg(uri, { title: `QR code to add ${account} to your authenticator app` }); } catch { picture = ''; }
  const links = gate ? '<p class="mfa-links"><button type="button" class="text-button" data-mfa-cancel>Cancel and sign out</button></p>' : '<p class="mfa-links"><button type="button" class="text-button" data-mfa-back>Back</button></p>';
  return `${header('Set up two-step verification', { esc })}
<ol class="mfa-steps"><li>Install an authenticator app on your phone if you do not have one.</li><li>${picture ? 'Scan this code with the app, or enter the key below.' : 'Enter this key in the app.'}</li><li>Enter the 6-digit code the app shows, to turn it on.</li></ol>
${picture ? `<div class="mfa-qr">${picture}</div>` : ''}
<p class="mfa-key">Key for ${esc(account)}: <code id="mfa-secret">${esc(groupSecret(secret))}</code></p>
<label class="mfa-field">Code from the app<input id="mfa-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]*" required></label>
${errorBox(error, { esc })}<button id="mfa-submit" type="submit" class="primary">Turn on</button>${links}`;
}

// Shown once, right after setting up or asking for new ones.
export function codesHtml(codes, { esc }) {
  return `${header('Save your backup codes', { esc })}<p class="tag-help">If you lose your phone, each of these signs you in once. Keep them somewhere safe, apart from your password. They are not shown again.</p><ol class="mfa-codes" aria-label="Backup codes">${codes.map(code => `<li><code>${esc(code)}</code></li>`).join('')}</ol><p class="mfa-links"><button type="button" data-mfa-copy>Copy the codes</button></p><button id="mfa-done" type="button" class="primary">I have saved them</button>`;
}

export function statusHtml(status, { esc, when }) {
  const left = status.backupCodesRemaining;
  const facts = status.enrolled
    ? `<dt>Status</dt><dd>On${status.enrolledAt ? ` since ${esc(when(status.enrolledAt))}` : ''}</dd><dt>Backup codes</dt><dd>${esc(plural(left, 'code'))} left${left <= 2 ? ' — make new ones soon' : ''}</dd>`
    : '<dt>Status</dt><dd>Off</dd>';
  const required = `<dt>Required for you</dt><dd>${status.required ? 'Yes, an administrator requires it' : 'No'}</dd>`;
  const actions = status.enrolled
    ? `<button type="button" data-mfa-action="backup-codes">New backup codes</button><button type="button" data-mfa-action="disable"${status.required ? ' disabled title="An administrator requires two-step verification for your account, so it cannot be turned off."' : ''}>Turn off</button>`
    : '<button type="button" class="primary" data-mfa-action="setup">Set up</button>';
  return `${header('Two-step verification', { esc, close: true, eyebrow: 'ACCOUNT SECURITY' })}<p class="tag-help">A code from an authenticator app, as well as your password, signs you in.</p><dl class="mfa-facts">${facts}${required}</dl><p class="mfa-actions">${actions}</p>`;
}

export function resetResultText(username, result) {
  return result.reset ? `Two-step verification reset for ${username}. They sign in with their password again.` : `${username} had no two-step verification to reset.`;
}
