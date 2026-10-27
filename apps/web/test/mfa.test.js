import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSecret, verifyHtml, setupHtml, codesHtml, statusHtml, resetResultText, turnOffResultText} from '../mfa.js';

// The two-step verification dialog: what each state offers, that nothing a server sent is put in the page unescaped, and that a person is never
// offered something the server will refuse (turning off what their role requires).
const esc = value => String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const when = value => `on ${value}`;
const ctx = { esc, when };
const enrollment = {
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', // secret-scan:allow (the RFC 6238 test secret, not a real one)
  uri: 'otpauth://totp/Nuvrion:ann%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Nuvrion&algorithm=SHA1&digits=6&period=30', // secret-scan:allow (the same test secret)
  account: 'ann@example.com'
};

test('the code prompt asks for six digits from the app, or a backup code, and says how to cancel', () => {
  const app = verifyHtml({ gate: true }, ctx);
  assert.match(app, /Enter your code/); assert.match(app, /inputmode="numeric"/); assert.match(app, /autocomplete="one-time-code"/); assert.match(app, /Use a backup code instead/); assert.match(app, /data-mfa-cancel>Cancel and sign out/);
  const backup = verifyHtml({ gate: true, backup: true }, ctx);
  assert.match(backup, /Backup code<input/); assert.doesNotMatch(backup, /inputmode="numeric"/); assert.match(backup, /Use the code from my app instead/); assert.match(backup, /Each one works once/);
  const action = verifyHtml({ gate: false, submit: 'Turn off', intro: 'Enter a code to turn it off.' }, ctx);
  assert.match(action, /Confirm with a code/); assert.match(action, />Turn off<\/button>/); assert.match(action, /data-mfa-back/); assert.doesNotMatch(action, /sign out/i); assert.match(action, /Enter a code to turn it off\./);
});

test('an error is announced to assistive technology, and an empty one is hidden', () => {
  assert.match(verifyHtml({ error: 'That code is not right.' }, ctx), /id="mfa-error" class="tag-error" role="alert">That code is not right\./);
  assert.match(verifyHtml({}, ctx), /id="mfa-error" class="tag-error" role="alert" hidden>/);
});

test('setting up shows the QR code drawn here and the same key to type, in groups, with a code field', () => {
  const html = setupHtml({ ...enrollment, gate: true }, ctx);
  assert.match(html, /<svg [^>]*role="img" aria-label="QR code to add ann@example\.com to your authenticator app"/);
  assert.match(html, /<code id="mfa-secret">GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ<\/code>/);
  assert.match(html, /Key for ann@example\.com/); assert.match(html, />Turn on<\/button>/); assert.match(html, /Cancel and sign out/);
  assert.doesNotMatch(html.replaceAll('http://www.w3.org/2000/svg', ''), /https?:\/\//, 'nothing is fetched from anywhere: the picture is drawn in the page');
  assert.match(setupHtml({ ...enrollment, gate: false }, ctx), /data-mfa-back/);
  assert.equal(groupSecret('ABCDEFGHIJ'), 'ABCD EFGH IJ'); assert.equal(groupSecret('ABCD'), 'ABCD');
});

test('a link too long for a QR code falls back to the key alone rather than failing', () => {
  const html = setupHtml({ ...enrollment, uri: 'x'.repeat(400) }, ctx);
  assert.doesNotMatch(html, /<svg/); assert.match(html, /Enter this key in the app/); assert.match(html, /mfa-secret/);
});

test('the backup codes are listed once, with a way to copy them and a clear way to go on', () => {
  const codes = Array.from({ length: 10 }, (_, i) => `abcd${i}-efgh${i}`);
  const html = codesHtml(codes, ctx);
  assert.equal((html.match(/<li><code>/g) ?? []).length, 10);
  assert.match(html, /aria-label="Backup codes"/); assert.match(html, /data-mfa-copy/); assert.match(html, /id="mfa-done"/); assert.match(html, /not shown again/);
});

test('the status says what is on, how many backup codes are left, and offers only what the server will accept', () => {
  const off = statusHtml({ enrolled: false, enrolledAt: null, backupCodesRemaining: 0, required: false }, ctx);
  assert.match(off, /Status<\/dt><dd>Off/); assert.match(off, /data-mfa-action="setup"/); assert.doesNotMatch(off, /data-mfa-action="disable"/);
  const on = statusHtml({ enrolled: true, enrolledAt: '2026-10-17T10:00:00Z', backupCodesRemaining: 7, required: false }, ctx);
  assert.match(on, /On since on 2026-10-17/); assert.match(on, /7 codes left/); assert.doesNotMatch(on, /make new ones soon/);
  assert.match(on, /data-mfa-action="backup-codes"/); assert.match(on, /data-mfa-action="disable">Turn off/);
  assert.match(statusHtml({ enrolled: true, enrolledAt: null, backupCodesRemaining: 1, required: false }, ctx), /1 code left — make new ones soon/);
  const required = statusHtml({ enrolled: true, enrolledAt: null, backupCodesRemaining: 10, required: true }, ctx);
  assert.match(required, /Yes, an administrator requires it/); assert.match(required, /data-mfa-action="disable" disabled title="An administrator requires/, 'an account that must use it cannot turn it off, and the button says why');
});

test('reset results are worded for the person who pressed the button', () => {
  assert.match(resetResultText('ann', { reset: true }), /reset for ann\. They sign in with their password again/);
  assert.match(resetResultText('ann', { reset: false }), /ann had no two-step verification to reset/);
});

test('whatever a server sends is escaped: account names, secrets, codes and role names', () => {
  const evil = '<img src=x onerror=alert(1)>';
  for (const html of [
    setupHtml({ secret: evil, uri: evil, account: evil }, ctx), codesHtml([evil], ctx), verifyHtml({ error: evil, intro: evil }, ctx),
    statusHtml({ enrolled: true, enrolledAt: evil, backupCodesRemaining: 3, required: false }, ctx)
  ]) { assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/); }
});

test('the notice after an administrator turns two-step off says what changed: the enrolment, the requirement, both or neither', () => {
  assert.equal(turnOffResultText('ada', { turnedOff: true, wasRequired: false }), 'Two-step verification turned off for ada. They sign in with their password alone.');
  assert.equal(turnOffResultText('ada', { turnedOff: true, wasRequired: true }), 'Two-step verification turned off for ada, and it is no longer required for them. They sign in with their password alone.');
  assert.equal(turnOffResultText('ada', { turnedOff: false, wasRequired: true }), 'Two-step verification is no longer required for ada.');
  assert.equal(turnOffResultText('ada', { turnedOff: false, wasRequired: false }), 'ada had no two-step verification to turn off.');
});
