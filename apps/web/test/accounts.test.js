import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { generatePassword, newUserHtml, credentialsHtml, setPasswordHtml, changePasswordHtml, changePasswordProblem, newUserBody, copyText, MIN_PASSWORD } from '../accounts.js';

// The account dialogs: what each offers, that a generated password is long enough and easy to read out, that the dialog that holds a person at "choose a new password" cannot be
// closed, and that nothing a server sent is put in the page unescaped.
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const ctx = { esc, roleLabel: role => role.displayName ?? role.name };
const roles = [{ name: 'platform_admin', displayName: 'platform admin' }, { name: 'operator', displayName: 'operator' }, { name: 'night_shift', displayName: 'night shift' }];

test('a generated password has sixteen characters in four groups, from an alphabet with no look-alikes, and differs each time', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const password = generatePassword(randomInt);
    assert.match(password, /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/); assert.ok(password.length >= MIN_PASSWORD);
    assert.doesNotMatch(password, /[0O1lI]/); seen.add(password);
  }
  assert.equal(seen.size, 200);
  let calls = 0; generatePassword(n => { calls += 1; assert.equal(n, 55); return 0; }); assert.equal(calls, 16, 'one draw per character, from 55 symbols');
});

test('the new-user dialog asks for username, name, role and first password, with sensible defaults, and offers a generated password', () => {
  const html = newUserHtml({ roles }, ctx);
  for (const id of ['account-username', 'account-display-name', 'account-role', 'account-password', 'account-generate', 'account-must-change', 'account-mfa', 'account-submit']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<option value="operator" selected>/, 'operator is the default role when it exists');
  assert.match(html, /id="account-must-change" name="mustChangePassword" type="checkbox" checked/); assert.doesNotMatch(html, /id="account-mfa"[^>]*checked/);
  assert.match(html, /autocomplete="off" spellcheck="false" minlength="12"/);
  assert.match(newUserHtml({ roles: [roles[0]] }, ctx), /<option value="platform_admin" selected>/, 'otherwise the first');
  const kept = newUserHtml({ roles, password: 'Typed-1234-abcd', error: 'That username is already taken.', defaults: { role: 'night_shift', mustChange: false, mfaRequired: true } }, ctx); // secret-scan:allow (fake test value)
  assert.match(kept, /<option value="night_shift" selected>/); assert.match(kept, /value="Typed-1234-abcd"/); assert.doesNotMatch(kept, /id="account-must-change"[^>]*checked/); assert.match(kept, /id="account-mfa" name="mfaRequired" type="checkbox" checked/);
  assert.match(kept, /id="account-error" class="tag-error" role="alert">That username is already taken\./);
  assert.match(html, /id="account-error" class="tag-error" role="alert" hidden>/);
});

test('the request is built from the form: trimmed, one role, flags as booleans', () => {
  assert.deepEqual(newUserBody({ username: ' ann.example ', displayName: ' Ann ', role: 'operator', password: 'p'.repeat(12), mustChangePassword: true, mfaRequired: false }), { username: 'ann.example', displayName: 'Ann', password: 'p'.repeat(12), roles: ['operator'], mustChangePassword: true, mfaRequired: false });
  assert.deepEqual(newUserBody({ username: 'a.b', displayName: 'A', role: 'x', password: 'p'.repeat(12) }).mustChangePassword, false);
});

test('what the administrator passes on is shown once, with a copy button and what happens at first sign-in', () => {
  const html = credentialsHtml({ title: 'User created', username: 'ann.example', password: 'Abcd-Efgh-Jklm-Npqr', mustChange: true, note: 'Give the person this.' }, ctx); // secret-scan:allow (fake test value)
  assert.match(html, /<code id="account-created-username">ann\.example<\/code>/); assert.match(html, /<code id="account-created-password">Abcd-Efgh-Jklm-Npqr<\/code>/);
  assert.match(html, /They choose their own password/); assert.match(html, /data-account-copy/); assert.match(html, /id="account-done"/);
  assert.match(credentialsHtml({ title: 't', username: 'u', password: 'p', mustChange: false, note: 'n' }, ctx), /They may keep this one/);
  assert.equal(copyText({ username: 'ann', password: 'pw' }), 'Username: ann\nPassword: pw');
});

test('setting a password names the person, says what it does, and offers a generated one', () => {
  const html = setPasswordHtml({ user: { username: 'ann.example', displayName: 'Ann Example' } }, ctx);
  assert.match(html, /Set a password for Ann Example/); assert.match(html, /ann\.example has forgotten their password/); assert.match(html, /Every session of theirs ends/);
  assert.match(html, /id="account-generate"/); assert.match(html, /name="mustChange" type="checkbox" checked/); assert.match(html, />Set password<\/button>/);
});

test('changing your own password asks for the current one, the new one twice, and the gate version cannot be closed', () => {
  const normal = changePasswordHtml({}, ctx);
  assert.match(normal, /Change password/); assert.match(normal, /id="account-close"/); assert.doesNotMatch(normal, /data-account-cancel/); assert.match(normal, /Your other sessions are signed out/);
  for (const [id, autocomplete] of [['account-current', 'current-password'], ['account-new', 'new-password'], ['account-confirm', 'new-password']]) assert.match(normal, new RegExp(`id="${id}"[^>]*autocomplete="${autocomplete}"`), id);
  const gate = changePasswordHtml({ gate: true, error: 'The current password is not right.' }, ctx);
  assert.match(gate, /Choose a new password/); assert.doesNotMatch(gate, /id="account-close"/, 'no Close button: the dialog is the only way forward'); assert.match(gate, /data-account-cancel>Cancel and sign out/);
  assert.match(gate, /An administrator set your first password/); assert.match(gate, />Continue<\/button>/); assert.match(gate, /role="alert">The current password is not right\./);
});

test('the checks that save a round trip: current given, 12 characters, the two agree, and it differs', () => {
  const ok = { currentPassword: 'old password 1', newPassword: 'a new password 2', confirmPassword: 'a new password 2' }; // secret-scan:allow (fake test value)
  assert.equal(changePasswordProblem(ok), null);
  assert.match(changePasswordProblem({ ...ok, currentPassword: '' }), /current password/);
  assert.match(changePasswordProblem({ ...ok, newPassword: 'short', confirmPassword: 'short' }), /at least 12/);
  assert.match(changePasswordProblem({ ...ok, newPassword: undefined }), /at least 12/);
  assert.match(changePasswordProblem({ ...ok, confirmPassword: 'different one 3' }), /not the same/); // secret-scan:allow (fake test value)
  assert.match(changePasswordProblem({ ...ok, newPassword: ok.currentPassword, confirmPassword: ok.currentPassword }), /different from the current/);
});

test('whatever a server sends is escaped: names, usernames, roles, passwords and errors', () => {
  const evil = '<img src=x onerror=alert(1)>';
  for (const html of [
    newUserHtml({ roles: [{ name: evil, displayName: evil }], password: evil, error: evil, defaults: { role: evil } }, ctx),
    credentialsHtml({ title: evil, username: evil, password: evil, mustChange: true, note: evil }, ctx),
    setPasswordHtml({ user: { username: evil, displayName: evil }, password: evil, error: evil }, ctx), changePasswordHtml({ error: evil }, ctx)
  ]) { assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/); }
});
