import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkipReason, launchBrowser } from '../../test-support/browser.js';
import { startConsole, ADMIN_PASSWORD } from '../../test-support/lab.js';
import { totpCode } from '../../../../modules/identity/src/totp.js';
import { midStep } from '../../../../modules/identity/test-support/totp-step.js';

// Automated accessibility checks (axe-core, WCAG 2.0 and 2.1 levels A and AA) on every page of the console and on the dialogs and menus a person can open from
// them, run in a real browser. A violation fails the test, with the rule, the elements and how many there are. These checks find what a machine can find (names,
// roles, labels, contrast, structure); they do not replace a review with a screen reader or keyboard-only walk-through of each journey.
const skip = await browserSkipReason();

// Every page and dialog is checked in the light theme (this file) and in the dark one (accessibility-dark.e2e.test.js, which sets NUVRION_AXE_THEME and runs this file), since a colour that passes on a
// pale panel can fail on a dark one (docs/themes.md). They are separate files because each lab server is one per process.
const theme = process.env.NUVRION_AXE_THEME === 'dark' ? 'dark' : 'light';
describe(`accessibility (axe-core, WCAG 2.1 A and AA), ${theme} theme`, { skip: skip ?? false }, () => {
  let lab, browser, page;
  before(async () => {
    lab = await startConsole();
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(lab.url);
    await page.evaluate(chosen => localStorage.setItem('nuvrion.theme', chosen), theme);
    await page.goto(lab.url);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
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
    for (const view of ['inventory', 'infrastructure', 'alert-rules', 'schedules', 'capacity', 'connections', 'monitor', 'users', 'health']) { await openView(view); await expectNoViolations(view); }
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
    await midStep();   // begin the short sequence of one-time-password uses early in a step
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
    // On a slow CI runner this click was sometimes lost (in 2 of 3 runs of one commit: the rule stayed, nothing was reported). So: wait for the bell to be closed, click again if the rule is
    // still there after a few seconds, and, if it still is, say what the page was doing.
    const ruleTable = () => page.evaluate(() => document.getElementById('alert-rule-table').innerText);
    await page.waitFor(() => !document.getElementById('notify-menu').open);
    for (let attempt = 1; attempt <= 3 && !/No alert rules yet/.test(await ruleTable()); attempt++) {
      await page.click('[data-alert-rule-delete]').catch(() => {});             // already gone: the deletion went through
      for (const until = Date.now() + 6000; Date.now() < until && !/No alert rules yet/.test(await ruleTable());) await settle(100);
    }
    const left = await ruleTable();
    assert.match(left, /No alert rules yet/, `the rule was not deleted; the table says "${left.replace(/\s+/g, ' ').slice(0, 160)}", the page said "${await page.evaluate(() => document.getElementById('notice').textContent)}", dialogs ${JSON.stringify(page.dialogs())}`);
    await page.click('#notify-menu summary'); await page.click('[data-notifications-read]'); await page.waitFor(() => document.getElementById('notify-count').hidden); await page.click('#notify-menu summary');
  });

  test('the schedule dialog, with a preview and for a tag, and the page with a schedule and its history', async () => {
    await openView('schedules');
    await page.click('[data-schedule-new]'); await shown('#schedule-form #schedule-name'); await settle(300);
    await expectNoViolations('schedule dialog');
    await page.fill('#schedule-name', 'Axe schedule');
    await page.click('#schedule-machine-list input[type=checkbox]'); await page.evaluate(() => { const time = document.getElementById('schedule-time'); time.value = '06:00'; }); await page.fill('#schedule-zone', 'UTC');
    await page.click('#schedule-check'); await page.waitFor(() => /would be covered/.test(document.getElementById('schedule-preview').innerText)); await settle(300);
    await expectNoViolations('schedule dialog with a preview');
    await page.click('#schedule-save'); await page.waitFor(() => !document.getElementById('schedule-dialog').open && /Axe schedule/.test(document.getElementById('schedule-table').innerText));
    await page.click('[data-schedule-run]'); await page.waitFor(() => /Run by hand/.test(document.getElementById('schedule-run-table').innerText)); await settle(400);
    await expectNoViolations('schedules page with a schedule and a run');
    await page.click('[data-schedule-edit]'); await page.waitFor(() => document.getElementById('schedule-dialog').open && document.getElementById('schedule-name').value === 'Axe schedule');
    await page.evaluate(() => { const select = document.getElementById('schedule-frequency'); select.value = 'weekly'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('input[name=targetKind][value=tag]'); await settle(300);
    await expectNoViolations('schedule dialog by tag, weekly');
    await page.click('#schedule-close');
    await page.waitFor(() => !document.getElementById('schedule-dialog').open);
    await page.click('[data-schedule-delete]'); await page.waitFor(() => /No schedules yet/.test(document.getElementById('schedule-table').innerText));
  });

  test('the Capacity page with a history, and the dialog with its chart', async () => {
    await lab.giveDatastoreHistory('datastore2', 10 * 1024 ** 3); await lab.giveDatastoreHistory('datastore1', 2 * 1024 ** 3);
    await openView('capacity');
    await page.waitFor(() => /\d+ days/i.test(document.getElementById('capacity-table').innerText)); await settle(400);
    await expectNoViolations('capacity page with forecasts');
    await page.click('[data-capacity-details]'); await shown('#capacity-form svg.capacity-chart'); await settle(300);
    await expectNoViolations('capacity dialog with a chart');
    await page.click('#capacity-close');
    await page.waitFor(() => !document.getElementById('capacity-dialog').open);
  });

  test('the webhooks section, the webhook dialog and the history dialog', async () => {
    const receiver = await lab.startReceiver();
    await openView('alert-rules');
    await page.waitFor(() => !document.getElementById('webhooks-card').hidden); await settle(300);
    await expectNoViolations('alert rules page with the webhooks section empty');
    await page.click('[data-webhook-new]'); await shown('#webhook-form #webhook-name'); await settle(300);
    await expectNoViolations('new webhook dialog');
    await page.fill('#webhook-name', 'Axe hook'); await page.fill('#webhook-url', `${receiver.url}/axe`);
    await page.click('#webhook-save'); await page.waitFor(() => !document.getElementById('webhook-dialog').open && /Axe hook/.test(document.getElementById('webhook-table').innerText));
    await page.click('[data-webhook-test]'); await page.waitFor(() => /Test message delivered/.test(document.getElementById('notice').innerText)); await settle(600);
    await expectNoViolations('alert rules page with a webhook');
    await page.click('[data-webhook-edit]'); await shown('#webhook-form #webhook-name'); await settle(300);
    await expectNoViolations('edit webhook dialog');
    await page.click('#webhook-close'); await page.waitFor(() => !document.getElementById('webhook-dialog').open);
    await page.click('[data-webhook-history]'); await shown('#webhook-history-form tbody tr'); await settle(300);
    await expectNoViolations('webhook history dialog');
    await page.click('#webhook-history-close'); await page.waitFor(() => !document.getElementById('webhook-history-dialog').open);
    await page.click('[data-webhook-delete]'); await page.waitFor(() => /No webhooks yet/.test(document.getElementById('webhook-table').innerText));
  });

  test('the Capacity tab for hosts and clusters, and its dialog with a chart', async () => {
    await lab.giveComputeHistory('esx-mock-01.lab.example', 'cpu', 800); await lab.giveComputeHistory('Mock cluster', 'memory', 8 * 1024 ** 3);
    await openView('capacity');
    await page.click('[data-capacity-tab=compute]'); await page.waitFor(() => /\d+ days/i.test(document.getElementById('capacity-compute-table').innerText)); await settle(500);
    await expectNoViolations('capacity page, hosts and clusters');
    await page.click('[data-capacity-compute-details]'); await shown('#capacity-form #capacity-metric'); await settle(300);
    await expectNoViolations('capacity dialog for a cluster without a chart');
    await page.evaluate(() => { const metric = document.getElementById('capacity-metric'); metric.value = 'memory'; metric.dispatchEvent(new Event('change', { bubbles: true })); });
    await shown('#capacity-form svg.capacity-chart'); await settle(300);
    await expectNoViolations('capacity dialog for a cluster with a chart');
    await page.click('#capacity-close'); await page.waitFor(() => !document.getElementById('capacity-dialog').open);
    await page.click('[data-capacity-tab=datastores]');
  });

  test('the Views menu open, the save dialog, and the inventory toolbar with the export button', async () => {
    await openView('inventory'); await page.waitFor(() => document.querySelectorAll('#inventory-table tr[data-select-resource]').length >= 2); await settle(300);
    await expectNoViolations('inventory toolbar with Views and Export CSV');
    await page.click('#views-button'); await settle(300);
    await expectNoViolations('views menu, empty');
    await page.click('[data-view-save]'); await shown('#view-form #view-name'); await settle(300);
    await expectNoViolations('save view dialog');
    await page.fill('#view-name', 'Axe view'); await page.click('#view-save');
    await page.waitFor(() => !document.getElementById('view-dialog').open && document.getElementById('views-button').textContent === 'Views: Axe view');
    await page.click('#views-button'); await settle(300);
    await expectNoViolations('views menu with a view in use');
    await page.click('[data-view-delete]'); await page.waitFor(() => document.getElementById('views-button').textContent === 'Views');
  });

  test('the command launcher, empty and with results', async () => {
    await page.click('#launcher-button'); await page.waitFor(() => document.getElementById('launcher-dialog').open && document.querySelector('#launcher-list [role=option]')); await settle(300);
    await expectNoViolations('command launcher, empty');
    await page.fill('#launcher-input', 'nuvrion'); await page.waitFor(() => document.querySelectorAll('#launcher-list [role=option]').length >= 2); await settle(300);
    await expectNoViolations('command launcher with results');
    await page.fill('#launcher-input', 'zzzqqq'); await page.waitFor(() => /Nothing matches/.test(document.getElementById('launcher-list').innerText)); await settle(300);
    await expectNoViolations('command launcher with no results');
    await page.press('Escape'); await page.waitFor(() => !document.getElementById('launcher-dialog').open);
  });
});
