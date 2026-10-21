import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkipReason, launchBrowser } from '../../test-support/browser.js';
import { startConsole, ADMIN_PASSWORD } from '../../test-support/lab.js';
import { totpCode } from '../../../../modules/identity/src/totp.js';

// Automated accessibility checks (axe-core, WCAG 2.0 and 2.1 levels A and AA) on every page of the console and on the dialogs and menus a person can open from
// them, run in a real browser. A violation fails the test, with the rule, the elements and how many there are. These checks find what a machine can find (names,
// roles, labels, contrast, structure); they do not replace a review with a screen reader or keyboard-only walk-through of each journey.
const skip = await browserSkipReason();

describe('accessibility (axe-core, WCAG 2.1 A and AA)', { skip: skip ?? false }, () => {
  let lab, browser, page;
  before(async () => {
    lab = await startConsole();
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(lab.url);
  });
  after(async () => { await page?.close(); await browser?.close(); await lab?.close(); });

  const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function expectNoViolations(name) {
    const violations = await page.axe();
    assert.deepEqual(violations, [], `${name}: ${violations.map(v => `${v.id} (${v.impact}, ${v.nodes}): ${v.help} - ${v.targets.join(' | ')}`).join('; ')}`);
  }
  const shown = selector => page.waitFor(selector => { const e = document.querySelector(selector); return e && e.getClientRects().length > 0; }, selector);
  const openView = async view => { await page.click(`#navigation button[data-view=${view}]`); await shown(`#view-${view}`); await settle(300); };
  const closeDialog = async selector => { await page.click(selector); await page.waitFor(selector => !document.querySelector(selector)?.getClientRects().length, selector); };

  test('the sign-in, create-account and reset-password pages', async () => {
    await expectNoViolations('sign-in');
    await page.clickText('Create account', '#login'); await shown('#signup-form');
    await expectNoViolations('create account');
    await page.clickText('Back to sign in', '#login'); await page.click('#show-reset'); await shown('#reset-form');
    await expectNoViolations('reset password');
    await page.clickText('Back to sign in', '#login'); await shown('#login-form');
  });

  test('every page of the console, signed in as an administrator', async () => {
    await page.fill('#login-form [name=username]', 'admin');
    await page.fill('#login-form [name=password]', ADMIN_PASSWORD);
    await page.clickText('Sign in →', '#login-form');
    await page.waitFor(() => [...document.querySelectorAll('h1')].some(h => h.offsetParent && h.textContent.includes('Platform Overview')));
    await expectNoViolations('overview');
    for (const view of ['inventory', 'infrastructure', 'alert-rules', 'connections', 'monitor', 'users', 'health']) { await openView(view); await expectNoViolations(view); }
    // a host selected: the tree with the selection marked and the detail with usage bars and the list of VMs
    await openView('infrastructure');
    await page.waitFor(() => document.querySelectorAll('#infrastructure-tree [data-infra-select]').length >= 9);
    await page.evaluate(() => [...document.querySelectorAll('#infrastructure-tree [data-infra-select]')].find(b => b.textContent.includes('esx-mock-01')).click());
    await page.waitFor(() => /esx-mock-01/.test(document.querySelector('#infrastructure-detail h2')?.textContent ?? ''));
    await expectNoViolations('infrastructure: a host');
    for (const tab of ['alerts', 'tasks', 'audit']) {
      await openView('monitor');
      await page.click(`#view-monitor [data-monitor-tab=${tab}]`);
      await page.waitFor(tab => document.querySelector('#view-monitor [data-monitor-tab].active')?.dataset.monitorTab === tab, tab);
      await settle(300);
      await expectNoViolations(`monitor: ${tab}`);
    }
  });

  test('the Monitor tabs say which one is selected, to assistive technology as well as to the eye', async () => {
    await openView('monitor');
    for (const tab of ['performance', 'alerts', 'tasks', 'audit']) {
      await page.click(`#view-monitor [data-monitor-tab=${tab}]`);
      await page.waitFor(tab => document.querySelector('#view-monitor [data-monitor-tab].active')?.dataset.monitorTab === tab, tab);
      const states = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#view-monitor [data-monitor-tab]')].map(b => [b.dataset.monitorTab, [b.getAttribute('role'), b.getAttribute('aria-selected')]])));
      for (const [name, [role, selected]] of Object.entries(states)) assert.deepEqual([role, selected], ['tab', String(name === tab)], `${name} while ${tab} is open`);
    }
  });

  test('the account menu is named by what it shows, and the Users page names every dropdown', async () => {
    const name = await page.evaluate(() => { const s = document.querySelector('details.account-menu summary'); return { label: s.getAttribute('aria-label'), text: s.innerText.replace(/\s+/g, ' ').trim() }; });
    assert.equal(name.label, null, 'no aria-label that could drift from the visible text');
    assert.match(name.text, /Platform Administrator/);
    await openView('users');
    const selects = await page.evaluate(() => [...document.querySelectorAll('#user-table select')].map(s => s.getAttribute('aria-label')));
    assert.ok(selects.length >= 2);
    for (const label of selects) assert.match(label, /^(Status of|Role of|Two-step verification for) .+/);
  });

  test('the account menu, and the dialogs opened from it', async () => {
    await openView('overview');
    await page.click('details.account-menu summary');
    await shown('.account-popover');
    await expectNoViolations('account menu');
    await page.click('#my-sessions');
    await shown('#sessions-close');
    await expectNoViolations('active sessions');
    await closeDialog('#sessions-close');
    await page.click('details.account-menu summary');
    await page.click('#upgrade-center');
    await shown('#upgrade-progress, .upgrade-dialog, dialog[open]');
    await settle(400);
    await expectNoViolations('upgrade center');
    await page.press('Escape');
    await settle(300);
  });

  test('the roles table and the role dialog (new, custom and built-in)', async () => {
    await openView('users');
    await page.waitFor(() => document.querySelectorAll('#role-table tr[data-role-row]').length >= 3);
    await expectNoViolations('roles table');
    await page.click('[data-role-new]'); await shown('#role-form #role-name'); await settle(300);
    await expectNoViolations('new role dialog');
    await closeDialog('#role-close');
    await page.click('[data-role-open=operator]'); await shown('#role-form'); await settle(300);
    await expectNoViolations('built-in role dialog');
    await closeDialog('#role-close');
  });

  test('the add-connection form and the dialogs opened for a VM', async () => {
    await openView('connections');
    await page.click('#show-connection-form');
    await shown('#connection-form');
    await expectNoViolations('add connection');
    await page.click('#cancel-connection');
    await openView('inventory');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 2);
    await page.click('input[aria-label="Select nuvrion-app-01"]');
    await page.clickText('Settings', '#vm-action-toolbar');
    await shown('#vm-settings-form');
    await settle(600);
    await expectNoViolations('VM settings');
    await closeDialog('#vm-settings-close');
    await page.click('#inventory-tag-button');                       // the tag dialog, empty and with a tag in it
    await shown('#tag-form #tag-key');
    await settle(300);
    await expectNoViolations('tag dialog');
    await page.fill('#tag-key', 'a11y'); await page.fill('#tag-value', 'check'); await page.click('#tag-set');
    await page.waitFor(() => /a11y: check/.test(document.getElementById('tag-form').innerText));
    await expectNoViolations('tag dialog with a tag');
    await page.click('[data-tag-remove=a11y]');
    await page.waitFor(() => /No tags set by Nuvrion yet/.test(document.getElementById('tag-form').innerText));
    await closeDialog('#tag-close');
    await page.clickText('Monitor', '#vm-action-toolbar');          // opens the VM's own monitoring page
    await page.waitFor(() => /Virtual machines \/ nuvrion-app-01 \/ Monitor/.test(document.getElementById('breadcrumb').innerText));
    await settle(600);
    await expectNoViolations('VM monitor page');
  });

  test('the two-step verification dialogs: status, setting up, backup codes, and the code prompt at sign-in (with a code and with a backup code)', async () => {
    const codeAt = (secret, steps) => totpCode(secret, Date.now() + steps * 30_000);
    const openMenuMfa = async () => { await page.click('details.account-menu summary'); await page.click('#my-mfa'); await page.waitFor(() => document.getElementById('mfa-dialog').open && /Two-step verification/.test(document.getElementById('mfa-form').innerText)); await settle(300); };
    await openMenuMfa();
    await expectNoViolations('two-step status (off)');
    await page.click('[data-mfa-action=setup]'); await shown('#mfa-secret'); await settle(300);
    await expectNoViolations('two-step setup (QR code and key)');
    const secret = (await page.text('#mfa-secret')).replace(/\s/g, '');
    await page.fill('#mfa-code', codeAt(secret, -1)); await page.click('#mfa-submit');
    await page.waitFor(() => document.querySelectorAll('#mfa-form .mfa-codes li').length === 10); await settle(300);
    await expectNoViolations('two-step backup codes');
    const codes = await page.evaluate(() => [...document.querySelectorAll('#mfa-form .mfa-codes code')].map(code => code.textContent));
    await page.click('#mfa-done'); await page.waitFor(() => !document.getElementById('mfa-dialog').open);
    await openMenuMfa();
    await expectNoViolations('two-step status (on)');
    await closeDialog('#mfa-close');
    // sign out and in again: the prompt over the sign-in page
    await page.click('details.account-menu summary'); await page.click('#logout'); await page.waitFor(() => document.getElementById('login')?.getClientRects().length > 0);
    await page.fill('#login-form [name=username]', 'admin'); await page.fill('#login-form [name=password]', ADMIN_PASSWORD); await page.clickText('Sign in →', '#login-form');
    await page.waitFor(() => document.getElementById('mfa-dialog').open && /Enter your code/.test(document.getElementById('mfa-form').innerText)); await settle(300);
    await expectNoViolations('two-step code prompt at sign-in');
    await page.click('[data-mfa-toggle-backup]'); await page.waitFor(() => /Backup code/.test(document.getElementById('mfa-form').innerText)); await settle(300);
    await expectNoViolations('two-step backup code prompt at sign-in');
    await page.fill('#mfa-code', codes[0]); await page.click('#mfa-submit');
    await page.waitFor(() => !document.getElementById('application').hidden && !document.getElementById('mfa-dialog').open);
    // turn it off again so the other tests see the lab as they expect it
    await openMenuMfa(); await page.click('[data-mfa-action=disable]'); await page.waitFor(() => /Turn off/.test(document.getElementById('mfa-submit')?.innerText ?? '')); await settle(300);
    await expectNoViolations('two-step confirm with a code');
    await page.fill('#mfa-code', codeAt(secret, 1)); await page.click('#mfa-submit');
    await page.waitFor(() => /Status\s*Off/.test(document.getElementById('mfa-form').innerText));
    await closeDialog('#mfa-close');
  });

  test('the account dialogs: a new user, the credentials to pass on, a temporary password, changing your own password, and the one that holds a person at "choose a new password"', async () => {
    await openView('users'); await page.waitFor(() => document.querySelectorAll('#user-table tr').length >= 1);
    await page.click('[data-new-user]'); await shown('#account-form #account-username'); await settle(300);
    await expectNoViolations('new user dialog');
    await page.fill('#account-username', 'axe.person'); await page.fill('#account-display-name', 'Axe Person'); await page.click('#account-generate');
    const first = await page.evaluate(() => document.getElementById('account-password').value);
    await page.click('#account-submit'); await page.waitFor(() => document.getElementById('account-created-password')); await settle(300);
    await expectNoViolations('new user: credentials to pass on');
    await page.click('#account-done'); await page.waitFor(() => !document.getElementById('account-dialog').open);
    await page.waitFor(() => [...document.querySelectorAll('[data-user-new-credentials]')].some(button => /Axe Person/.test(button.innerText)), undefined, { timeout: 20000 });
    await page.evaluate(() => [...document.querySelectorAll('[data-user-new-credentials]')].find(button => /Axe Person/.test(button.innerText)).click());
    await shown('#account-form #account-password'); await settle(300);
    await expectNoViolations('set a temporary password');
    await closeDialog('#account-close');
    await page.click('details.account-menu summary'); await page.click('#my-password'); await shown('#account-form #account-current'); await settle(300);
    await expectNoViolations('change password');
    await closeDialog('#account-close');
    // the dialog over the sign-in page that holds a person at "choose a new password"
    await page.click('details.account-menu summary'); await page.click('#logout'); await page.waitFor(() => document.getElementById('login')?.getClientRects().length > 0);
    await page.fill('#login-form [name=username]', 'axe.person'); await page.fill('#login-form [name=password]', first); await page.clickText('Sign in →', '#login-form');
    await page.waitFor(() => document.getElementById('account-dialog').open && /Choose a new password/.test(document.getElementById('account-form').innerText)); await settle(300);
    await expectNoViolations('choose a new password (at first sign-in)');
    await page.fill('#account-current', first); await page.fill('#account-new', 'Axe-Person-Own-Password-4!'); await page.fill('#account-confirm', 'Axe-Person-Own-Password-4!'); await page.click('#account-submit');   // secret-scan:allow (fake test credential)
    await page.waitFor(() => !document.getElementById('application').hidden && !document.getElementById('account-dialog').open);
    // back to the administrator for the tests that follow
    await page.click('details.account-menu summary'); await page.click('#logout'); await page.waitFor(() => document.getElementById('login')?.getClientRects().length > 0);
    await page.fill('#login-form [name=username]', 'admin'); await page.fill('#login-form [name=password]', ADMIN_PASSWORD); await page.clickText('Sign in →', '#login-form');
    await page.waitFor(() => !document.getElementById('application').hidden);
  });

  test('the alert rule dialog with a preview, the page with an open alert, and the notification bell open', async () => {
    await openView('alert-rules');
    await page.click('[data-alert-rule-new]'); await shown('#alert-rule-form #alert-rule-name'); await settle(300);
    await expectNoViolations('alert rule dialog');
    await page.fill('#alert-rule-name', 'Axe rule'); await page.fill('#alert-rule-threshold', '10'); await page.fill('#alert-rule-duration', '0');
    await page.click('#alert-rule-check'); await page.waitFor(() => /match/.test(document.getElementById('alert-rule-preview').innerText)); await settle(300);
    await expectNoViolations('alert rule dialog with a preview');
    await page.click('#alert-rule-save'); await page.waitFor(() => !document.getElementById('alert-rule-dialog').open && /Axe rule/.test(document.getElementById('alert-rule-table').innerText));
    await page.click('[data-alert-evaluate]'); await page.waitFor(() => document.querySelector('#alert-open-table [data-alert-row]')); await settle(400);
    await expectNoViolations('alert rules page with an open alert');
    await page.click('#notify-menu summary'); await page.waitFor(() => /Axe rule/.test(document.getElementById('notify-panel').innerText)); await settle(300);
    await expectNoViolations('notification bell, open');
    await page.click('#notify-menu summary');
    await page.click('[data-alert-rule-delete]'); await page.waitFor(() => /No alert rules yet/.test(document.getElementById('alert-rule-table').innerText));
    await page.click('#notify-menu summary'); await page.click('[data-notifications-read]'); await page.waitFor(() => document.getElementById('notify-count').hidden); await page.click('#notify-menu summary');
  });
});
