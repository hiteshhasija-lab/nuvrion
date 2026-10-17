import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkipReason, launchBrowser } from '../../test-support/browser.js';
import { startConsole, ADMIN_PASSWORD } from '../../test-support/lab.js';

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
    for (const view of ['inventory', 'infrastructure', 'connections', 'monitor', 'users', 'health']) { await openView(view); await expectNoViolations(view); }
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
    for (const label of selects) assert.match(label, /^(Status|Role) of .+/);
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
});
