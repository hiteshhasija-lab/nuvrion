import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkipReason, launchBrowser } from '../../test-support/browser.js';
import { startConsole, ADMIN_PASSWORD } from '../../test-support/lab.js';
import { totpCode } from '../../../../modules/identity/src/totp.js';

// End-to-end tests of the console in a real browser: the real API and web files run in-process with in-memory services and the mock provider, Chrome drives the
// pages the way a person would (typing, clicking, pressing keys), and each test checks what the person would see. They need Chrome (NUVRION_CHROME, or the usual
// locations); without it they skip, and CI sets NUVRION_REQUIRE_BROWSER_TESTS=1 so that a missing browser is a failure there.
const NEW_PASSWORD = 'A-Long-Enough-Password-3!', DIFFERENT_PASSWORD = 'A-Different-Password-4!';   // secret-scan:allow (fake test credentials)
const skip = await browserSkipReason();
const EXPECTED_BEFORE_SIGN_IN = /\/api\/v1\/auth\/me/;   // the page asks who is signed in before anyone is, and Chrome logs the 401 it gets
// Chrome reports this for any request in flight when the machine's network interface changes (it happened on a CI runner); it is the
// browser's own event, not something the console did, and a real failure to load a file shows as a different error.
const BROWSER_NETWORK_EVENT = /net::ERR_NETWORK_CHANGED/;
const unexpected = problems => problems.filter(p => !EXPECTED_BEFORE_SIGN_IN.test(p) && !BROWSER_NETWORK_EVENT.test(p));

describe('the console in a browser', { skip: skip ?? false }, () => {
  let lab, browser, operator;
  before(async () => {
    lab = await startConsole();
    operator = await lab.createUser({ username: 'olivia.operator', displayName: 'Olivia Operator', role: 'operator' });
    browser = await launchBrowser();
  });
  after(async () => { await browser?.close(); await lab?.close(); });

  const newPage = async () => { const page = await browser.newPage(); await page.goto(lab.url); return page; };
  const signIn = async (page, username = 'admin', password = ADMIN_PASSWORD) => {
    await page.fill('#login-form [name=username]', username);
    await page.fill('#login-form [name=password]', password);
    await page.clickText('Sign in →', '#login-form');
  };
  const signedIn = page => page.waitFor(() => [...document.querySelectorAll('h1')].some(h => h.offsetParent && h.textContent.includes('Platform Overview')));
  const openView = async (page, view) => {
    await page.click(`#navigation button[data-view=${view}]`);
    await page.waitFor(view => { const section = document.getElementById(`view-${view}`); return section && section.getClientRects().length > 0; }, view);
  };
  const MONITOR_HEADINGS = { performance: /VIRTUAL MACHINES/i, alerts: /Alert history/i, tasks: /Task history/i, audit: /Audit history/i };
  const openMonitorTab = async (page, tab) => {                  // Alerts, Tasks and Audit are tabs of the Monitor page
    await openView(page, 'monitor');
    await page.click(`#view-monitor [data-monitor-tab=${tab}]`);
    await page.waitFor(tab => document.querySelector('#view-monitor [data-monitor-tab].active')?.dataset.monitorTab === tab, tab);
    await page.waitFor(pattern => new RegExp(pattern, 'i').test(document.getElementById('view-monitor').innerText), MONITOR_HEADINGS[tab].source);
  };
  const powerOf = (page, name) => page.evaluate(name => [...document.querySelectorAll('#view-inventory tbody tr')].find(r => r.textContent.includes(name))?.querySelector('.power-indicator')?.getAttribute('aria-label') ?? null, name);

  test('the sign-in page loads cleanly: title, language, the form, and every script and style it asks for', async () => {
    const page = await newPage();
    assert.equal(await page.evaluate(() => document.title), 'Nuvrion Operations Console');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    for (const field of ['username', 'password']) assert.ok(await page.visible(`#login-form [name=${field}]`), field);
    assert.ok(await page.visible('#login-form button:not([type=button])'), 'a sign-in button');
    assert.deepEqual(unexpected(page.problems()), [], 'no script errors and no failed downloads');
    assert.ok(!await page.visible('#signup-form') && !await page.visible('#reset-form'), 'only the sign-in form shows');
    await page.close();
  });

  test('a wrong password is refused with a message, and the page stays on sign-in', async () => {
    const page = await newPage();
    await signIn(page, 'admin', 'not-the-password');
    await page.waitFor(() => document.getElementById('login-error')?.innerText.trim().length > 0);
    assert.match(await page.text('#login-error'), /incorrect|invalid|failed|try again/i);
    assert.ok(await page.visible('#login-form'));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('h1')].some(h => h.offsetParent && h.textContent.includes('Platform Overview'))), false);
    assert.equal((await page.cookies()).some(c => c.name === 'nuvrion_session'), false, 'no session was started');
    await page.close();
  });

  test('signing in shows the overview; the session cookie cannot be read by page scripts, and a reload keeps the person signed in', async () => {
    const page = await newPage();
    await signIn(page);
    await signedIn(page);
    assert.ok(!await page.visible('#login-form'));
    assert.match(await page.text('body'), /Platform Administrator/);
    const cookie = (await page.cookies()).find(c => c.name === 'nuvrion_session');
    assert.ok(cookie?.httpOnly, 'the session cookie is HttpOnly');
    assert.equal(await page.evaluate(() => document.cookie.includes('nuvrion_session')), false);
    await page.reload();
    await signedIn(page);
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('signing out returns to sign-in, and the old session no longer works', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    const cookie = (await page.cookies()).find(c => c.name === 'nuvrion_session');
    await page.click('details.account-menu summary');           // Sign out is in the account menu at the top right
    await page.click('#logout');
    await page.waitFor(() => document.getElementById('login')?.getClientRects().length > 0);
    assert.ok(await page.visible('#login-form'));
    const afterwards = await fetch(`${lab.url}/api/v1/auth/me`, { headers: { cookie: `nuvrion_session=${cookie.value}` } });
    assert.equal(afterwards.status, 401, 'the server ended the session, not just the page');
    await page.close();
  });

  test('every navigation entry opens its own view and no other, without script errors', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    for (const view of ['overview', 'inventory', 'connections', 'monitor', 'users', 'health']) {
      await openView(page, view);
      const open = await page.evaluate(() => [...document.querySelectorAll('section[id^=view-]')].filter(s => s.getClientRects().length).map(s => s.id));
      assert.ok(open.includes(`view-${view}`), `${view} is shown`);
      assert.deepEqual(open, [`view-${view}`], `${view}: only its own view is shown`);
    }
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('the Monitor page has Performance, Alerts, Tasks and Audit tabs, each showing its own history', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    for (const tab of ['performance', 'alerts', 'tasks', 'audit']) {
      await openMonitorTab(page, tab);
      assert.equal(await page.evaluate(() => document.querySelectorAll('#view-monitor [data-monitor-tab].active').length), 1, `${tab}: exactly one tab is active`);
    }
    assert.match(await page.text('#view-monitor'), /identity\.login/, 'the audit history shows the sign-in just made');
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('the inventory lists the discovered VMs with their power state, and the search box narrows the list', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'inventory');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 2);
    assert.match(await page.text('#view-inventory tbody'), /nuvrion-app-01[\s\S]*nuvrion-db-01/);
    assert.equal(await powerOf(page, 'nuvrion-app-01'), 'Power state: Running');
    await page.fill('#inventory-search', 'db-01');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 1);
    assert.match(await page.text('#view-inventory tbody'), /nuvrion-db-01/);
    await page.fill('#inventory-search', 'no such machine');
    await page.waitFor(() => !document.querySelector('#view-inventory tbody tr[data-select-resource]'));
    await page.close();
  });

  test('powering on a stopped VM asks for confirmation, queues a task, and the list then shows it running', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'inventory');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 2);
    assert.equal(await powerOf(page, 'nuvrion-db-01'), 'Power state: Stopped');
    await page.click('input[aria-label="Select nuvrion-db-01"]');
    await page.clickText('Power on', '#vm-action-toolbar');
    await page.waitFor(() => document.getElementById('notice')?.innerText.includes('Power on queued'));
    assert.deepEqual(page.dialogs(), [{ type: 'confirm', message: 'Power on 1 selected virtual machine?' }]);
    await page.waitFor(() => [...document.querySelectorAll('#view-inventory tbody tr')].find(r => r.textContent.includes('nuvrion-db-01'))?.querySelector('.power-indicator')?.getAttribute('aria-label') === 'Power state: Running', { timeout: 15000 });
    const tasks = await lab.api('GET', '/api/v1/tasks');
    assert.ok(tasks.json.items.some(t => t.operation === 'start' && t.status === 'completed'), 'the task finished successfully');
    await openMonitorTab(page, 'tasks');
    await page.waitFor(() => /start|power on/i.test(document.getElementById('view-monitor').innerText));
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('declining the confirmation changes nothing', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'inventory');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 2);
    const before = (await lab.api('GET', '/api/v1/tasks')).json.items.length;
    page.dismissDialogs();
    await page.click('input[aria-label="Select nuvrion-app-01"]');
    await page.clickText('Restart', '#vm-action-toolbar');
    await page.waitFor(() => true);
    assert.equal(page.dialogs().length, 1);
    assert.equal((await lab.api('GET', '/api/v1/tasks')).json.items.length, before, 'no task was created');
    await page.close();
  });

  const openSignUp = async page => {
    await page.clickText('Create account', '#login');
    await page.waitFor(() => document.getElementById('signup-form')?.getClientRects().length > 0);
  };
  const fillSignUp = async (page, { displayName, username, password, confirmPassword = password }) => {
    await page.fill('#signup-form [name=displayName]', displayName);
    await page.fill('#signup-form [name=username]', username);
    await page.fill('#signup-form [name=password]', password);
    await page.fill('#signup-form [name=confirmPassword]', confirmPassword);
  };
  const accountExists = async username => (await lab.api('GET', '/api/v1/users')).json.items.some(u => u.username === username);

  test('creating an account: the form itself refuses an invalid user name and a short password, and nothing is sent', async () => {
    const page = await newPage();
    await openSignUp(page);
    await fillSignUp(page, { displayName: 'Two Words', username: 'two words', password: 'short' });
    await page.clickText('Register', '#signup-form');
    const validity = await page.evaluate(() => { const f = document.getElementById('signup-form'); return { valid: f.checkValidity(), userNamePattern: f.elements.username.validity.patternMismatch, passwordTooShort: f.elements.password.validity.tooShort }; });
    assert.deepEqual(validity, { valid: false, userNamePattern: true, passwordTooShort: true });
    assert.equal(await accountExists('two words'), false);
    assert.ok(await page.visible('#signup-form'), 'the person stays on the form');
    await page.close();
  });

  test('creating an account: a blank display name is refused by the server with a message (not as a duplicate), and a mismatched confirmation is caught before sending', async () => {
    const page = await newPage();
    await openSignUp(page);
    await fillSignUp(page, { displayName: '   ', username: 'blank.name', password: NEW_PASSWORD });
    await page.clickText('Register', '#signup-form');
    await page.waitFor(() => document.getElementById('signup-error')?.innerText.trim().length > 0);
    assert.doesNotMatch(await page.text('#signup-error'), /already exists|taken/i, 'invalid input is not reported as a duplicate user name');
    assert.equal(await accountExists('blank.name'), false, 'no account was created');
    await fillSignUp(page, { displayName: 'Mismatch', username: 'mis.match', password: NEW_PASSWORD, confirmPassword: DIFFERENT_PASSWORD });
    await page.clickText('Register', '#signup-form');
    await page.waitFor(() => /match/i.test(document.getElementById('signup-error')?.innerText ?? ''));
    assert.equal(await accountExists('mis.match'), false);
    await page.close();
  });

  test('creating an account: a valid registration is accepted as pending and shows the person what happens next', async () => {
    const page = await newPage();
    await openSignUp(page);
    await fillSignUp(page, { displayName: 'Wendy Web', username: 'wendy.web', password: NEW_PASSWORD });
    await page.clickText('Register', '#signup-form');
    const [shown] = await page.waitForDialog();                 // the page tells the person with a box that carries their one-time recovery code
    assert.equal(shown.type, 'prompt');
    assert.match(shown.message, /awaiting administrator approval/i);
    assert.ok(shown.defaultValue?.length >= 8, 'the recovery code is offered for copying');
    await page.waitFor(() => document.getElementById('login-form')?.getClientRects().length > 0);
    const created = (await lab.api('GET', '/api/v1/users')).json.items.find(u => u.username === 'wendy.web');
    assert.equal(created?.status, 'pending');
    const signIn = await fetch(`${lab.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'wendy.web', password: NEW_PASSWORD }) });
    assert.notEqual(signIn.status, 200, 'a pending account cannot sign in yet');
    await page.close();
  });

  test('"Forgot password?" opens the reset form and "Back to sign in" returns; "Create account" and back likewise', async () => {
    const page = await newPage();
    await page.click('#show-reset');
    await page.waitFor(() => document.getElementById('reset-form')?.getClientRects().length > 0);
    assert.ok(!await page.visible('#login-form'));
    await page.clickText('Back to sign in', '#login');
    await page.waitFor(() => document.getElementById('login-form')?.getClientRects().length > 0);
    await openSignUp(page);
    assert.ok(!await page.visible('#login-form'));
    await page.clickText('Back to sign in', '#login');
    await page.waitFor(() => document.getElementById('login-form')?.getClientRects().length > 0);
    await page.close();
  });

  test('the sign-in form can be used from the keyboard alone: Tab reaches every control in order and Enter submits', async () => {
    const page = await newPage();
    await page.evaluate(() => document.querySelector('#login-form [name=username]').focus());
    const order = [];
    for (let i = 0; i < 6; i++) { order.push(await page.evaluate(() => { const e = document.activeElement; return e.name || e.id || e.textContent.trim().slice(0, 14); })); await page.press('Tab'); }
    assert.deepEqual(order.slice(0, 5), ['username', 'password', 'toggle-login-password', 'remember-login', 'show-reset']);
    assert.match(order[5], /Sign in/);
    await page.fill('#login-form [name=username]', 'admin');
    await page.fill('#login-form [name=password]', ADMIN_PASSWORD);
    await page.press('Enter');
    await signedIn(page);
    await page.close();
  });

  test('the show-password button reveals and hides the password and says which it will do', async () => {
    const page = await newPage();
    await page.fill('#login-form [name=password]', 'visible-text-123');
    const type = () => page.evaluate(() => document.querySelector('#login-form [name=password]').type);
    assert.equal(await type(), 'password');
    assert.equal(await page.evaluate(() => document.getElementById('toggle-login-password').getAttribute('aria-label')), 'Show password');
    await page.click('#toggle-login-password');
    assert.equal(await type(), 'text');
    assert.match(await page.evaluate(() => document.getElementById('toggle-login-password').getAttribute('aria-label')), /hide/i);
    await page.click('#toggle-login-password');
    assert.equal(await type(), 'password');
    await page.close();
  });

  test('an operator sees the inventory but not the Users page, and the server refuses the administrator\'s calls too', async () => {
    const page = await newPage();
    await signIn(page, operator.username, operator.password);
    await signedIn(page);
    assert.ok(await page.visible('#navigation button[data-view=inventory]'));
    assert.equal(await page.visible('#navigation button[data-view=users]'), false, 'Users is hidden from an operator');
    await openView(page, 'connections');
    assert.equal(await page.visible('#show-connection-form'), false, 'an operator can look at connections but is not offered "Add connection"');
    const login = await fetch(`${lab.url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operator) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${lab.url}/api/v1/users`, { headers: { cookie } })).status, 403);
    await page.close();
  });

  test('the sign-in page and the overview fit a phone-width screen without sideways scrolling', async () => {
    const page = await newPage();
    await page.setViewport(375, 812);
    await page.reload();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(await overflow() <= 1, `the sign-in page overflows by ${await overflow()}px`);
    await signIn(page); await signedIn(page);
    assert.ok(await overflow() <= 1, `the overview overflows by ${await overflow()}px`);
    await page.close();
  });

  test('when the Workstation agent stops reporting, a VM last seen running shows as unknown and can still be powered on; when it reports again the real state is back', async () => {
    const agent = await lab.addWorkstationAgent();
    const vm = (name, powerState) => ({ id: `D:\\VMs\\${name}\\${name}.vmx`, nativeId: `D:\\VMs\\${name}\\${name}.vmx`, name, path: `D:\\VMs\\${name}\\${name}.vmx`, powerState, vcpuCount: 2, memoryBytes: 4 * 1024 ** 3, privateIps: ['10.0.0.66'], toolsStatus: 'Running', hardware: { cdDvdDrives: [] } });
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    await agent.report([vm('ESXi8', 'running')], tenMinutesAgo);          // the last thing the agent said, a while ago: "ESXi8 is running"
    await agent.discover();
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'inventory');
    await page.waitFor(() => [...document.querySelectorAll('#view-inventory tbody tr')].some(r => r.textContent.includes('ESXi8')));
    assert.equal(await powerOf(page, 'ESXi8'), 'Power state: Unknown — provider unreachable', 'a state nobody has confirmed is not shown as Running');
    await page.click('input[aria-label="Select ESXi8"]');
    const powerOn = () => page.evaluate(() => { const b = [...document.querySelectorAll('#vm-action-toolbar button')].find(x => x.textContent.includes('Power on')); return b ? { disabled: b.disabled, title: b.title } : null; });
    const offered = await powerOn();
    assert.equal(offered.disabled, false, 'Power on is available although the last known state was Running');
    assert.match(offered.title, /not known \(last known: running\)/);
    await page.clickText('Power on', '#vm-action-toolbar');
    await page.waitFor(() => document.getElementById('notice')?.innerText.includes('Power on queued'));
    const tasks = (await lab.api('GET', '/api/v1/tasks')).json.items;
    assert.ok(tasks.some(t => t.operation === 'start' && /ESXi8/.test(t.target?.name ?? t.targetId ?? JSON.stringify(t))), 'the operation was accepted and a task was created');

    assert.equal(await agent.completeCommands('running'), 1, 'the agent was asked, once, to start it');
    await agent.report([vm('ESXi8', 'running')]);                            // the agent is back, has started it, and says it is running
    await agent.discover();
    await page.click('#refresh');
    await page.waitFor(() => [...document.querySelectorAll('#view-inventory tbody tr')].find(r => r.textContent.includes('ESXi8'))?.querySelector('.power-indicator')?.getAttribute('aria-label') === 'Power state: Running', { timeout: 15000 });
    await page.click('input[aria-label="Select ESXi8"]');
    assert.equal((await powerOn()).disabled, true, 'with a confirmed Running state, Power on is not offered');
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('an administrator adds an agent build and upgrades an agent from the Connections page, and follows the result; an operator does not see the panel', async () => {
    const agent = await lab.addWorkstationAgent({ name: 'UPGRADE-LAB' });
    const reportAs = async (deploymentId, body) => (await fetch(`${lab.url}/api/v1/agents/${agent.agentId}/upgrades/${deploymentId}/report`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-secret': agent.secret }, body: JSON.stringify(body) })).status;
    const rowText = page => page.evaluate(id => document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? '', agent.agentId);
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'connections');
    // The full CI suite runs this alongside the database and broker tests, so the four initial
    // agent-management requests can take longer than the browser helper's general 15s limit.
    await page.waitFor(() => { const panel = document.getElementById('agent-fleet'); return panel && !panel.hidden && panel.getClientRects().length > 0; }, { timeout: 30000 });
    await page.waitFor(id => document.querySelector(`#agent-table [data-agent-row="${id}"]`), agent.agentId);
    assert.match(await rowText(page), /UPGRADE-LAB[\s\S]*0\.1\.46[\s\S]*no upgrades yet/i);
    assert.equal(await page.evaluate(() => document.getElementById('agent-builds').textContent.includes('No builds yet')), true);

    // add a build: a small file that is a Windows executable by its first two bytes
    await page.click('#agent-build-toggle');
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([0x4d, 0x5a, 1, 2, 3, 4, 5, 6])], 'nuvrion-workstation-agent.exe'));
      document.getElementById('agent-build-file').files = transfer.files;
    });
    await page.fill('#agent-build-version', '0.1.88-lab.1');
    await page.fill('#agent-build-base', 'https://platform.invalid');
    await page.click('#agent-build-submit');
    await page.waitFor(() => document.getElementById('agent-builds').textContent.includes('0.1.88-lab.1'), { timeout: 15000 });
    const builds = await page.evaluate(() => document.getElementById('agent-builds').textContent);
    assert.match(builds, /https:\/\/platform\.invalid/);
    assert.match(builds, /on the platform/i);
    assert.match(await page.evaluate(() => document.getElementById('agent-fleet-message').innerText), /registered 0\.1\.88-lab\.1/i);

    // the agent is told a newer build is available, and the address it was uploaded with was remembered as the address agents use
    assert.match(await rowText(page), /0\.1\.88-lab\.1 available/i);
    assert.equal(await page.evaluate(() => document.getElementById('agent-address').value), 'https://platform.invalid');
    assert.match(await page.evaluate(() => document.getElementById('agent-address-note').innerText), /download builds from https:\/\/platform\.invalid/);

    // upgrade the agent
    await page.click(`[data-agent-upgrade="${agent.agentId}"]`);
    await page.waitFor(() => document.getElementById('agent-upgrade-dialog').open);
    assert.match(await page.evaluate(() => document.getElementById('agent-upgrade-release').innerText), /0\.1\.88-lab\.1/);
    await page.click('#agent-upgrade-confirm');
    await page.waitFor(id => /waiting for the agent/i.test(document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? ''), agent.agentId, { timeout: 15000 });
    const history = (await lab.api('GET', `/api/v1/agents/${agent.agentId}/upgrade-deployments`)).json.items;
    assert.equal(history.length, 1);
    assert.equal(await page.evaluate(id => Boolean(document.querySelector(`[data-agent-cancel="${id}"]`)), agent.agentId), true, 'an unfinished upgrade offers Cancel, not Upgrade');

    // the agent reports progress and then success; the page follows it without being touched
    assert.equal(await reportAs(history[0].deploymentId, { status: 'downloading' }), 200);
    await page.waitFor(id => /downloading/i.test(document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? ''), agent.agentId, { timeout: 20000 });
    assert.equal(await reportAs(history[0].deploymentId, { status: 'installed', detail: 'Upgraded from 0.1.46 to 0.1.88-lab.1.' }), 200);
    await page.waitFor(id => /upgraded 0\.1\.88-lab\.1/i.test(document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? ''), agent.agentId, { timeout: 20000 });
    assert.equal(await page.evaluate(id => Boolean(document.querySelector(`[data-agent-upgrade="${id}"]`)), agent.agentId), true);

    // a refusal by the agent is explained in words, and an upgrade can be cancelled
    await page.click(`[data-agent-upgrade="${agent.agentId}"]`);
    await page.waitFor(() => document.getElementById('agent-upgrade-dialog').open);
    await page.click('#agent-upgrade-confirm');
    await page.waitFor(id => document.querySelector(`[data-agent-cancel="${id}"]`), agent.agentId, { timeout: 15000 });
    const second = (await lab.api('GET', `/api/v1/agents/${agent.agentId}/upgrade-deployments`)).json.items[0];
    assert.equal(await reportAs(second.deploymentId, { status: 'failed', detail: 'NUV_AGENT_UPGRADE_KEY_NOT_PINNED: No upgrade signing key is pinned in bootstrap.json' }), 200);
    await page.waitFor(id => /no upgrade signing key pinned/i.test(document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? ''), agent.agentId, { timeout: 20000 });
    await page.click(`[data-agent-upgrade="${agent.agentId}"]`);
    await page.waitFor(() => document.getElementById('agent-upgrade-dialog').open);
    await page.click('#agent-upgrade-confirm');
    await page.waitFor(id => document.querySelector(`[data-agent-cancel="${id}"]`), agent.agentId, { timeout: 15000 });
    await page.click(`[data-agent-cancel="${agent.agentId}"]`);
    await page.waitFor(id => /failed/i.test(document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? ''), agent.agentId, { timeout: 20000 });
    // automatic upgrades: switch on for this agent with a window; the build was cancelled on this agent a moment ago, so the row says it will not be tried again; switch off
    await page.click(`[data-agent-policy="${agent.agentId}"]`);
    await page.waitFor(() => document.getElementById('agent-policy-dialog').open);
    await page.evaluate(() => { document.getElementById('agent-policy-on').click(); document.getElementById('agent-policy-window').click(); });
    await page.fill('#agent-policy-start', '01:00');
    await page.fill('#agent-policy-end', '05:00');
    await page.fill('#agent-policy-zone', 'America/Chicago');
    await page.click('#agent-policy-save');
    await page.waitFor(id => /automatic upgrades will not try 0\.1\.88-lab\.1 again/i.test(document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? ''), agent.agentId, { timeout: 15000 });
    const policies = (await lab.api('GET', '/api/v1/agent-upgrades/policies')).json.items;
    assert.deepEqual(policies.map(item => [item.agentId, item.autoUpgrade, item.windowStart, item.windowEnd, item.windowTimezone]), [[agent.agentId, true, '01:00', '05:00', 'America/Chicago']]);
    await page.click(`[data-agent-policy="${agent.agentId}"]`);
    await page.waitFor(() => document.getElementById('agent-policy-dialog').open);
    await page.evaluate(() => { document.getElementById('agent-policy-on').click(); });
    await page.click('#agent-policy-save');
    await page.waitFor(id => !/automatic upgrades will not try|upgrades automatically/i.test(document.querySelector(`#agent-table [data-agent-row="${id}"]`)?.innerText ?? ''), agent.agentId, { timeout: 15000 });
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();

    const operatorPage = await newPage();
    await signIn(operatorPage, operator.username, operator.password); await signedIn(operatorPage);
    await openView(operatorPage, 'connections');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(await operatorPage.evaluate(() => { const panel = document.getElementById('agent-fleet'); return !panel || panel.hidden; }), true, 'an operator does not see agent management');
    await operatorPage.close();
  });
  // ---- the Overview's estate panels and their click-through (apps/web/dashboard.js) ---------------------------------------------------------------------------------
  const inventoryRows = page => page.evaluate(() => document.querySelectorAll('#view-inventory tbody tr').length);
  const estateTotal = page => page.evaluate(() => Number(document.querySelector('#summary-cards [data-drill-clear] strong').textContent));
  const countOf = (page, selector) => page.evaluate(selector => Number(document.querySelector(selector)?.textContent.replace(/\D+/g, '')), selector);

  test('the Overview shows the power and health of the estate, a card for each provider, and the latest alerts', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await page.waitFor(() => document.querySelectorAll('#estate-health .breakdown-row').length > 0 && document.querySelectorAll('#provider-overview .provider-card').length > 0);
    const text = await page.text('#view-overview');
    assert.match(text, /Power and health/i); assert.match(text, /Provider overview/i); assert.match(text, /Recent alerts/i);
    assert.match(await page.text('#provider-overview'), /VMware vSphere \/ vCenter[\s\S]*connection healthy/i);
    const powerTotal = await page.evaluate(() => [...document.querySelectorAll('#estate-health [data-drill-power] strong, #estate-health .breakdown:first-child .breakdown-zero strong')].reduce((a, e) => a + Number(e.textContent), 0));
    assert.equal(powerTotal, await estateTotal(page), 'the power groups add up to the estate');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#summary-cards button.metric-card')].map(b => b.querySelector('p').textContent)), ['Virtual machines', 'Running', 'Open tasks', 'Critical alerts'], 'the four tiles are buttons');
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('a count on the Overview opens the inventory showing exactly those VMs; the chip says why, and removing it shows them all again', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await page.waitFor(() => document.querySelectorAll('#estate-health [data-drill-power]').length > 0);
    const total = await estateTotal(page);
    const groups = await page.evaluate(() => [...document.querySelectorAll('#estate-health [data-drill-power]')].map(b => [b.dataset.drillPower, Number(b.querySelector('strong').textContent)]));
    assert.ok(groups.length > 0);
    for (const [group, expected] of groups) {
      await openView(page, 'overview');
      await page.click(`#estate-health [data-drill-power=${group}]`);
      await page.waitFor(() => document.getElementById('view-inventory')?.getClientRects().length > 0);
      assert.equal(await inventoryRows(page), expected, `${group}: the list has the ${expected} the Overview counted`);
      assert.match(await page.text('#inventory-drill-chips'), new RegExp(`Power: ${group[0].toUpperCase()}`, 'i'));
    }
    // one chip off leaves the other filters; "Clear filters" removes everything
    await openView(page, 'overview');
    await page.click('#estate-health [data-drill-health]');
    await page.waitFor(() => /Health:/.test(document.getElementById('inventory-drill-chips')?.innerText ?? ''));
    await page.click('#inventory-drill-chips [data-clear-drill=health]');
    await page.waitFor(() => document.getElementById('inventory-drill-chips').hidden);
    assert.equal(await inventoryRows(page), total, 'removing the only chip shows every VM');
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('the Running tile and a provider card open the inventory on what they count; the platform filter shows the provider', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await page.waitFor(() => document.querySelectorAll('#provider-overview .provider-card').length > 0);
    await page.click('#summary-cards [data-drill-power=running]');
    await page.waitFor(() => document.getElementById('view-inventory')?.getClientRects().length > 0);
    assert.match(await page.text('#inventory-drill-chips'), /Power: Running/);
    await openView(page, 'overview');
    const vcenterVms = await countOf(page, '#provider-overview [data-drill-platform=vmware_vcenter] .provider-count');
    await page.click('#provider-overview [data-drill-platform=vmware_vcenter]');
    await page.waitFor(() => document.getElementById('view-inventory')?.getClientRects().length > 0);
    assert.equal(await page.evaluate(() => document.getElementById('inventory-state').value), 'vmware_vcenter');
    assert.equal(await inventoryRows(page), vcenterVms, 'the provider card’s count is the list it opens');
    assert.equal(await page.evaluate(() => document.getElementById('inventory-drill-chips').hidden), true, 'a provider card does not leave an old power filter behind');
    await openView(page, 'overview');
    const firstLegend = await countOf(page, '#estate-summary [data-drill-platform] em');
    await page.click('#estate-summary [data-drill-platform]');
    await page.waitFor(() => document.getElementById('view-inventory')?.getClientRects().length > 0);
    assert.equal(await inventoryRows(page), firstLegend, 'the legend’s count is the list it opens');
    await page.evaluate(() => { const select = document.getElementById('inventory-state'); select.value = 'aws'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitFor(() => !document.getElementById('inventory-empty').hidden);
    assert.match(await page.text('#inventory-empty'), /No virtual machines match/, 'a filtered-out list says so instead of "add a connection"');
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('a failing connection raises an alert that appears on the Overview, and the alert opens the alert history', async () => {
    const created = await lab.api('POST', '/api/v1/connections', { name: 'Broken ESXi', providerType: 'vmware_vsphere', connectionType: 'esxi', endpointUri: 'https://127.0.0.1:1/sdk', credential: { username: 'user', password: 'pass' } }); // secret-scan:allow (fake test credential)
    assert.equal(created.status, 201, JSON.stringify(created.json));
    try {
      await lab.api('POST', `/api/v1/connections/${created.json.id}/discover`);
      const deadline = Date.now() + 10000;
      let alerts = [];
      while (Date.now() < deadline && !alerts.length) { alerts = ((await lab.api('GET', '/api/v1/connection-alerts')).json?.items ?? []).filter(a => a.connectionName === 'Broken ESXi' || a.connectionId === created.json.id); if (!alerts.length) await new Promise(resolve => setTimeout(resolve, 250)); }
      assert.ok(alerts.length, 'the failed discovery raised an alert');
      const page = await newPage();
      await signIn(page); await signedIn(page);
      await page.waitFor(() => /Broken ESXi/.test(document.getElementById('recent-alerts')?.innerText ?? ''));
      const row = await page.text('#recent-alerts .alert-row');
      assert.match(row, /Broken ESXi/); assert.match(row, /active/i);
      assert.match(await page.text('#provider-overview'), /VMware ESXi[\s\S]*unreachable|VMware ESXi[\s\S]*connection/);
      await page.click('#recent-alerts .alert-row');
      await page.waitFor(() => document.getElementById('view-monitor')?.getClientRects().length > 0 && document.querySelector('#view-monitor [data-monitor-tab].active')?.dataset.monitorTab === 'alerts');
      await page.waitFor(() => /Alert history/.test(document.getElementById('view-monitor').innerText));
      assert.deepEqual(unexpected(page.problems()), []);
      await page.close();
    } finally { await lab.api('DELETE', `/api/v1/connections/${created.json.id}`); }
  });
  // ---- tags (apps/web/tags.js) --------------------------------------------------------------------------------------------------------------------------------------
  const rowNames = page => page.evaluate(() => [...document.querySelectorAll('#view-inventory tbody tr .resource-name strong')].map(e => e.textContent));
  const rowChips = (page, name) => page.evaluate(name => [...document.querySelectorAll('#view-inventory tbody tr')].find(r => r.querySelector('.resource-name strong')?.textContent === name)?.querySelector('.tag-chips')?.innerText.replace(/\s+/g, ' ').trim() ?? '', name);
  const dialogOpen = page => page.evaluate(() => document.getElementById('tag-dialog').open);
  const setTag = async (page, key, value = '') => {
    await page.fill('#tag-key', key); if (value) await page.fill('#tag-value', value);
    await page.click('#tag-set');
  };

  test('a VM is tagged from the dialog: the chip appears in the list and the detail, the tag filter finds it, and removing the tag takes it away', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'inventory');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length >= 2);
    const names = await rowNames(page), total = names.length, target = names[0];
    assert.equal(await page.evaluate(() => document.getElementById('inventory-tag-button').disabled), true, 'Tag is disabled until a VM is chosen');
    await page.evaluate(name => [...document.querySelectorAll('#view-inventory tbody tr')].find(r => r.querySelector('.resource-name strong')?.textContent === name).querySelector('[data-select-bulk]').click(), target);
    await page.waitFor(() => !document.getElementById('inventory-tag-button').disabled);
    await page.click('#inventory-tag-button');
    await page.waitFor(() => document.getElementById('tag-dialog').open && document.getElementById('tag-key'));
    assert.match(await page.text('#tag-title'), new RegExp(target));
    await setTag(page, 'Env', ' prod ');
    await page.waitFor(() => /env: prod/.test(document.querySelector('#tag-form .tag-list')?.innerText ?? ''));
    await page.click('#tag-close');
    await page.waitFor(() => !document.getElementById('tag-dialog').open);
    await page.waitFor(name => [...document.querySelectorAll('#view-inventory tbody tr')].some(r => r.querySelector('.resource-name strong')?.textContent === name && /env: prod/.test(r.innerText)), target);
    assert.equal(await rowChips(page, target), 'env: prod', 'the key was stored in lower case and the value trimmed');
    // the filter lists the tag with its count, and narrows the list to it
    assert.match(await page.evaluate(() => [...document.querySelectorAll('#inventory-tag option')].map(o => o.textContent).join('|')), /env \(any value\) · 1/);
    await page.evaluate(() => { const select = document.getElementById('inventory-tag'); select.value = 'env=prod'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 1);
    assert.deepEqual(await rowNames(page), [target]);
    assert.match(await page.text('#inventory-drill-chips'), /Tag: env = prod/);
    await page.click('#inventory-drill-chips [data-clear-drill=tag]');
    await page.waitFor(total => document.querySelectorAll('#view-inventory tbody tr').length === total, total);
    // the detail shows the tag, too; removing it clears it everywhere
    await page.click('#view-inventory tbody tr .resource-name');
    await page.waitFor(() => /Tags/.test(document.querySelector('.vm-facts')?.innerText ?? ''));
    assert.match(await page.text('.vm-facts'), /env: prod/);
    await page.click('.vm-facts [data-open-tags]');
    await page.waitFor(() => document.getElementById('tag-dialog').open && document.querySelector('[data-tag-remove=env]'));
    await page.click('[data-tag-remove=env]');
    await page.waitFor(() => /No tags set by Nuvrion yet/.test(document.getElementById('tag-form').innerText));
    await page.click('#tag-close');
    await page.waitFor(name => ![...document.querySelectorAll('#view-inventory tbody tr')].find(r => r.querySelector('.resource-name strong')?.textContent === name)?.querySelector('.tag-chips'), target);
    assert.equal(await rowChips(page, target), '', 'the chip is gone from the list');
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('the whole selection is tagged at once, the dialog says how many carry each tag, and a refused key is explained without closing the dialog', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'inventory');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr [data-select-bulk]').length >= 2);
    await page.evaluate(() => document.querySelectorAll('#view-inventory tbody tr [data-select-bulk]')[0].click());
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr [data-select-bulk]:checked').length === 1);
    await page.evaluate(() => document.querySelectorAll('#view-inventory tbody tr [data-select-bulk]:not(:checked)')[0].click());   // the list was redrawn by the first click
    await page.waitFor(() => /^Tag 2/.test(document.getElementById('inventory-tag-button').textContent));
    await page.click('#inventory-tag-button');
    await page.waitFor(() => document.getElementById('tag-dialog').open && document.getElementById('tag-key'));
    assert.match(await page.text('#tag-title'), /2 virtual machines/);
    await setTag(page, 'Bad Key', 'x');
    await page.waitFor(() => !document.getElementById('tag-error').hidden);
    assert.match(await page.text('#tag-error'), /may use only letters, digits/);
    assert.equal(await dialogOpen(page), true, 'the dialog stays open so the key can be fixed');
    await setTag(page, 'aws:name', 'x');
    await page.waitFor(() => /reserved/.test(document.getElementById('tag-error').innerText));
    await page.fill('#tag-key', 'batch'); await page.fill('#tag-value', 'one');
    await page.click('#tag-set');
    await page.waitFor(() => /on all 2/.test(document.querySelector('#tag-form .tag-list')?.innerText ?? ''));
    assert.match(await page.text('#tag-form .tag-list'), /batch: one/);
    await page.fill('#tag-key', 'team'); await page.click('#tag-set');
    await page.waitFor(() => document.querySelectorAll('#tag-form .tag-list li').length === 2);
    await page.click('#tag-close');
    for (const name of await rowNames(page)) if ((await page.evaluate(name => [...document.querySelectorAll('#view-inventory tbody tr')].find(r => r.querySelector('.resource-name strong')?.textContent === name)?.querySelector('[data-select-bulk]')?.checked, name))) {
      assert.match(await rowChips(page, name), /batch: one/);
    }
    // leave the lab as the other tests expect it
    await page.click('#inventory-tag-button');
    await page.waitFor(() => document.getElementById('tag-dialog').open && document.querySelector('[data-tag-remove=batch]'));
    await page.click('[data-tag-remove=batch]'); await page.waitFor(() => document.querySelectorAll('#tag-form .tag-list li').length === 1);
    await page.click('[data-tag-remove=team]'); await page.waitFor(() => /No tags set by Nuvrion yet/.test(document.getElementById('tag-form').innerText));
    await page.click('#tag-close');
    const refusals = unexpected(page.problems()).filter(p => /status of 422.*\/api\/v1\/tag-operations/.test(p));
    assert.equal(refusals.length, 2, 'the browser logged the two refusals this test provoked, and nothing else');
    assert.deepEqual(unexpected(page.problems()).filter(p => !refusals.includes(p)), []);
    await page.close();
  });

  test('an auditor sees the tags but is not offered the Tag button, and the server refuses the call anyway', async () => {
    const auditor = await lab.createUser({ username: 'ada.auditor', displayName: 'Ada Auditor', role: 'auditor' });
    const tagged = await lab.api('GET', '/api/v1/resources');
    const id = tagged.json.items[0].id;
    assert.equal((await lab.api('POST', '/api/v1/tag-operations', { resourceIds: [id], set: [{ key: 'seen', value: 'by-auditor' }] })).status, 200);
    try {
      const page = await newPage();
      await signIn(page, auditor.username, auditor.password); await signedIn(page);
      await openView(page, 'inventory');
      await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr .tag-chip').length > 0);
      assert.match(await page.text('#view-inventory tbody'), /seen: by-auditor/);
      assert.equal(await page.evaluate(() => document.getElementById('inventory-tag-button').hidden), true);
      assert.deepEqual(unexpected(page.problems()), []);
      await page.close();
    } finally { await lab.api('POST', '/api/v1/tag-operations', { resourceIds: [id], remove: ['seen'] }); }
  });

  // ---- the Infrastructure page and where a VM runs (apps/web/infrastructure.js) ----------------------------------------------------------------------------------------
  const chooseInfrastructure = (page, text) => page.evaluate(text => [...document.querySelectorAll('#infrastructure-tree [data-infra-select]')].find(b => b.textContent.includes(text)).click(), text);

  test('the Infrastructure page shows the hierarchy a connection reports; a host lists its VMs, and a VM opens from there with its host named in the detail', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'infrastructure');
    await page.waitFor(() => document.querySelectorAll('#infrastructure-tree [data-infra-select]').length >= 9);
    const tree = await page.text('#infrastructure-tree');
    for (const name of ['Mock datacenter', 'Mock cluster', 'esx-mock-01.lab.example', 'esx-mock-02.lab.example', 'datastore1', 'datastore2', 'VLAN 10 Production', 'VLAN 20 Databases']) assert.ok(tree.includes(name), name);
    await chooseInfrastructure(page, 'esx-mock-01');
    await page.waitFor(() => /esx-mock-01/.test(document.querySelector('#infrastructure-detail h2')?.textContent ?? ''));
    const detail = await page.text('#infrastructure-detail');
    assert.match(detail, /nuvrion-app-01/); assert.doesNotMatch(detail, /nuvrion-db-01/, 'the other host’s VM is not listed');
    assert.match(detail, /VLAN 10 Production/); assert.match(detail, /datastore1/);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#infrastructure-tree [aria-current=true]').length), 1);
    // a datastore shows its space
    await chooseInfrastructure(page, 'datastore2');
    await page.waitFor(() => /datastore2/.test(document.querySelector('#infrastructure-detail h2')?.textContent ?? ''));
    assert.match(await page.text('#infrastructure-detail'), /Space used[\s\S]*90%/);
    // the VM opens in the inventory and names where it runs; the host there leads back
    await chooseInfrastructure(page, 'esx-mock-01');
    await page.waitFor(() => document.querySelector('#infrastructure-detail [data-select-resource]'));
    await page.click('#infrastructure-detail [data-select-resource]');
    await page.waitFor(() => document.getElementById('view-inventory')?.getClientRects().length > 0 && document.querySelector('.vm-facts [data-infra-open]'));
    assert.match(await page.text('.vm-facts'), /Runs on\s*esx-mock-01\.lab\.example/);
    // opened from the sidebar the detail also has General Information, which names the host, datastores and networks
    await page.evaluate(() => [...document.querySelectorAll('#vm-sidebar-list [data-select-resource]')].find(b => b.textContent.includes('nuvrion-app-01')).click());
    await page.waitFor(() => /Datastores/.test([...document.querySelectorAll('.vm-info-panel')].map(p => p.innerText).join(' ')));
    const general = await page.evaluate(() => [...document.querySelectorAll('.vm-info-panel')].map(p => p.innerText).join(' '));
    assert.match(general, /Host\s*esx-mock-01\.lab\.example/); assert.match(general, /Datastores\s*datastore1/); assert.match(general, /Networks\s*VLAN 10 Production/);
    await page.click('.vm-info-panel [data-infra-open]');
    await page.waitFor(() => document.getElementById('view-infrastructure')?.getClientRects().length > 0 && /esx-mock-01/.test(document.querySelector('#infrastructure-detail h2')?.textContent ?? ''));
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  test('the inventory search finds a VM by the host, datastore or network it runs on', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'inventory');
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length >= 2);
    await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length >= 2);
    for (const [word, expected] of [['esx-mock-02', 'nuvrion-db-01'], ['datastore1', 'nuvrion-app-01'], ['vlan 20', 'nuvrion-db-01']]) {
      await page.fill('#inventory-search', word);
      await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 1);
      assert.deepEqual(await rowNames(page), [expected], word);
    }
    await page.fill('#inventory-search', '');
    assert.deepEqual(unexpected(page.problems()), []);
    await page.close();
  });

  // ---- roles on the Users page (apps/web/roles.js) ----------------------------------------------------------------------------------------------------------------------
  test('an administrator creates a role in the console, gives it to a user who then sees what it allows and nothing more, and a role people hold cannot be deleted', async () => {
    const page = await newPage();
    await signIn(page); await signedIn(page);
    await openView(page, 'users');
    await page.waitFor(() => document.querySelectorAll('#role-table tr[data-role-row]').length >= 3);
    const builtIn = await page.evaluate(() => [...document.querySelectorAll('#role-table tr[data-role-row]')].map(r => [r.dataset.roleRow, /built-in/i.test(r.innerText), Boolean(r.querySelector('[data-role-delete]'))]));
    assert.deepEqual(builtIn.filter(r => r[1]).map(r => r[0]).sort(), ['auditor', 'operator', 'platform_admin']);
    assert.ok(builtIn.filter(r => r[1]).every(r => r[2] === false), 'a built-in role offers no Delete');
    // a built-in role opens read-only
    await page.click('[data-role-open=operator]');
    await page.waitFor(() => document.getElementById('role-dialog').open && /Built-in roles are part of the platform/.test(document.getElementById('role-form').innerText));
    assert.equal(await page.evaluate(() => !document.getElementById('role-save') && [...document.querySelectorAll('#role-form input[name=permission]')].every(box => box.disabled)), true);
    await page.click('#role-close'); await page.waitFor(() => !document.getElementById('role-dialog').open);
    // a new role: ticking resource.tag keeps resource.view ticked; unticking resource.view takes resource.tag with it; a refused name is explained in the dialog
    await page.click('[data-role-new]');
    await page.waitFor(() => document.getElementById('role-dialog').open && document.getElementById('role-name'));
    await page.evaluate(() => document.querySelector('#role-form input[value="resource.view"]').click());
    await page.waitFor(() => !document.querySelector('#role-form input[value="resource.view"]').checked);
    await page.evaluate(() => document.querySelector('#role-form input[value="resource.tag"]').click());
    await page.waitFor(() => document.querySelector('#role-form input[value="resource.view"]').checked && document.querySelector('#role-form input[value="resource.tag"]').checked);
    await page.fill('#role-name', 'operator'); await page.click('#role-save');
    await page.waitFor(() => /built-in role/.test(document.getElementById('role-error').innerText) && !document.getElementById('role-error').hidden);
    assert.equal(await page.evaluate(() => document.getElementById('role-dialog').open), true, 'the dialog stays open with the reason');
    await page.fill('#role-name', 'Night Shift'); await page.fill('#role-description', 'tags machines at night');
    await page.click('#role-save');
    await page.waitFor(() => !document.getElementById('role-dialog').open && document.querySelector('#role-table [data-role-row=night_shift]'));
    assert.match(await page.text('#role-table [data-role-row=night_shift]'), /tags machines at night[\s\S]*resource\.view[\s\S]*resource\.tag/);
    // the role is offered in the user list, and a user who holds it sees the Tag button but not the Users page
    const keeper = await lab.createUser({ username: 'nina.night', displayName: 'Nina Night', role: 'night_shift' });
    const other = await newPage();
    await signIn(other, keeper.username, keeper.password); await signedIn(other);
    await openView(other, 'inventory');
    await other.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length >= 2);
    assert.equal(await other.evaluate(() => document.getElementById('inventory-tag-button').hidden), false, 'the role allows tagging');
    assert.equal(await other.evaluate(() => document.querySelector('[data-view=users]').hidden), true, 'and not administration');
    await other.click('input[aria-label="Select nuvrion-app-01"]');
    await other.waitFor(() => /1 selected/.test(document.querySelector('#vm-action-toolbar .bulk-count')?.innerText ?? ''));
    assert.equal(await other.evaluate(() => [...document.querySelectorAll('[data-bulk-operation]')].every(button => button.disabled)), true, 'nor operating machines: with a machine chosen, every power action is still disabled');
    assert.deepEqual(unexpected(other.problems()), []);
    await other.close();
    // refresh: the user list now shows the role for Nina, the table counts her, and Delete is not offered while she holds it
    await page.evaluate(() => document.querySelector('#navigation button[data-view=overview]').click());
    await openView(page, 'users');
    await page.waitFor(() => [...document.querySelectorAll('#role-table [data-role-row=night_shift] td')][2]?.textContent.trim() === '1', undefined, { timeout: 20000 });
    assert.equal(await page.evaluate(() => document.querySelector('[data-role-delete=night_shift]').disabled), true);
    assert.match(await page.evaluate(() => document.querySelector('[data-role-delete=night_shift]').title), /Held by 1 user/);
    const refusals = unexpected(page.problems()).filter(p => /status of 422.*\/api\/v1\/roles/.test(p));
    assert.equal(refusals.length, 1, 'the browser logged the one refusal this test provoked (a built-in name), and nothing else');
    assert.deepEqual(unexpected(page.problems()).filter(p => !refusals.includes(p)), []);
    await page.close();
  });

  // ---- two-step verification (apps/web/mfa.js) -----------------------------------------------------------------------------------------------------------------------------
  // Codes are computed with the real clock; the steps one person uses are strictly increasing (previous, current, next), which the one-use rule needs and the tolerance allows.
  const codeAt = (secret, steps) => totpCode(secret, Date.now() + steps * 30_000);
  const openAccountMfa = async page => { await page.click('details.account-menu summary'); await page.click('#my-mfa'); await page.waitFor(() => document.getElementById('mfa-dialog').open && /Two-step verification/.test(document.getElementById('mfa-form').innerText)); };
  const signOut = async page => { await page.click('details.account-menu summary'); await page.click('#logout'); await page.waitFor(() => document.getElementById('login')?.getClientRects().length > 0); };
  const mfaRefusals = problems => unexpected(problems).filter(p => /status of (422|403|429)/.test(p));

  test('a person sets up two-step verification from the account menu; the next sign-in asks for a code, refuses a wrong one, and accepts a backup code once', async () => {
    const mia = await lab.createUser({ username: 'mia.mfa', displayName: 'Mia MFA', role: 'operator' });
    const page = await newPage();
    await signIn(page, mia.username, mia.password); await signedIn(page);
    await openAccountMfa(page);
    assert.match(await page.text('#mfa-form'), /Status\s*Off/);
    await page.click('[data-mfa-action=setup]');
    await page.waitFor(() => document.getElementById('mfa-secret'));
    assert.equal(await page.evaluate(() => document.querySelectorAll('#mfa-form .mfa-qr svg[role=img]').length), 1, 'the QR code is drawn in the page');
    const secret = (await page.text('#mfa-secret')).replace(/\s/g, '');
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await page.fill('#mfa-code', '000000'); await page.click('#mfa-submit');
    await page.waitFor(() => !document.getElementById('mfa-error').hidden && /not right/.test(document.getElementById('mfa-error').innerText));
    await page.fill('#mfa-code', codeAt(secret, -1)); await page.click('#mfa-submit');
    await page.waitFor(() => document.querySelectorAll('#mfa-form .mfa-codes li').length === 10);
    const backupCodes = await page.evaluate(() => [...document.querySelectorAll('#mfa-form .mfa-codes code')].map(code => code.textContent));
    assert.ok(backupCodes.every(code => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(code)));
    await page.click('#mfa-done');
    await page.waitFor(() => !document.getElementById('mfa-dialog').open);
    await openAccountMfa(page);
    assert.match(await page.text('#mfa-form'), /On since[\s\S]*10 codes left/);
    await page.click('#mfa-close'); await page.waitFor(() => !document.getElementById('mfa-dialog').open);
    // sign in again: the password is not enough
    await signOut(page);
    await signIn(page, mia.username, mia.password);
    await page.waitFor(() => document.getElementById('mfa-dialog').open && /Enter your code/.test(document.getElementById('mfa-form').innerText));
    assert.equal(await page.evaluate(() => document.getElementById('application').hidden), true, 'nothing of the console is shown yet');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'mfa-code', 'the code field has the focus');
    await page.fill('#mfa-code', '123456'); await page.click('#mfa-submit');
    await page.waitFor(() => /not right/.test(document.getElementById('mfa-error').innerText) && !document.getElementById('mfa-error').hidden);
    await page.click('[data-mfa-toggle-backup]');
    await page.waitFor(() => /Backup code/.test(document.getElementById('mfa-form').innerText));
    await page.fill('#mfa-code', backupCodes[0]); await page.click('#mfa-submit');
    await signedIn(page);
    await openAccountMfa(page);
    assert.match(await page.text('#mfa-form'), /9 codes left/);
    await page.click('#mfa-close');
    // the same backup code does not work twice; the code from the app does (the next step)
    await signOut(page);
    await signIn(page, mia.username, mia.password);
    await page.waitFor(() => document.getElementById('mfa-dialog').open);
    await page.click('[data-mfa-toggle-backup]'); await page.waitFor(() => /Backup code/.test(document.getElementById('mfa-form').innerText));
    await page.fill('#mfa-code', backupCodes[0]); await page.click('#mfa-submit');
    await page.waitFor(() => !document.getElementById('mfa-error').hidden);
    await page.click('[data-mfa-toggle-backup]'); await page.waitFor(() => /Open your authenticator app/.test(document.getElementById('mfa-form').innerText));
    await page.fill('#mfa-code', codeAt(secret, 1)); await page.click('#mfa-submit');
    await signedIn(page);
    assert.ok(mfaRefusals(page.problems()).length >= 3, 'the browser logged the refusals this test provoked');
    assert.deepEqual(unexpected(page.problems()).filter(p => !/status of (422|403)/.test(p)), []);
    await page.close();
  });

  test('cancelling the code prompt signs the person out; five wrong codes end the sign-in', async () => {
    const user = await lab.createUser({ username: 'ned.mfa', displayName: 'Ned MFA', role: 'operator' });
    const page = await newPage();
    await signIn(page, user.username, user.password); await signedIn(page);
    await openAccountMfa(page); await page.click('[data-mfa-action=setup]'); await page.waitFor(() => document.getElementById('mfa-secret'));
    const secret = (await page.text('#mfa-secret')).replace(/\s/g, '');
    await page.fill('#mfa-code', codeAt(secret, -1)); await page.click('#mfa-submit');
    await page.waitFor(() => document.querySelectorAll('#mfa-form .mfa-codes li').length === 10);
    await page.click('#mfa-done'); await signOut(page);
    await signIn(page, user.username, user.password);
    await page.waitFor(() => document.getElementById('mfa-dialog').open);
    await page.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('mfa-dialog').open), true, 'the prompt cannot be dismissed with Escape');
    await page.click('[data-mfa-cancel]');
    await page.waitFor(() => !document.getElementById('mfa-dialog').open && document.getElementById('login-form').getClientRects().length > 0);
    await signIn(page, user.username, user.password);
    await page.waitFor(() => document.getElementById('mfa-dialog').open);
    for (let i = 0; i < 5; i++) { await page.fill('#mfa-code', '000000'); await page.click('#mfa-submit'); if (i < 4) await page.waitFor(n => document.getElementById('mfa-error').innerText.length > 0 && !document.getElementById('mfa-error').hidden, i); }
    await page.waitFor(() => !document.getElementById('mfa-dialog').open && /ended this sign-in/.test(document.getElementById('login-error').innerText));
    await page.close();
  });

  test('an administrator requires two-step verification for one person: their open session is held at setup at once, others are not, they cannot turn it off, and a reset ends their session', async () => {
    const user = await lab.createUser({ username: 'pat.policy', displayName: 'Pat Policy', role: 'operator' });
    const person = await newPage();
    await signIn(person, user.username, user.password); await signedIn(person);
    const admin = await newPage();
    await signIn(admin); await signedIn(admin);
    await openView(admin, 'users');
    await admin.waitFor(() => [...document.querySelectorAll('#user-table tr')].some(row => /pat\.policy/.test(row.innerText)));
    const rowOf = () => admin.evaluate(() => { const row = [...document.querySelectorAll('#user-table tr')].find(r => /pat\.policy/.test(r.innerText)); return { select: row.querySelector('[data-user-mfa]').value, state: row.querySelector('[data-user-mfa]').closest('td').querySelector('small').innerText }; });
    assert.deepEqual(await rowOf(), { select: 'false', state: 'Not set up' });
    await admin.evaluate(() => { const row = [...document.querySelectorAll('#user-table tr')].find(r => /pat\.policy/.test(r.innerText)), select = row.querySelector('[data-user-mfa]'); select.value = 'true'; select.dispatchEvent(new Event('change', { bubbles: true })); row.querySelector('[data-user-save]').click(); });
    await admin.waitFor(() => /pat\.policy updated/.test(document.getElementById('notice').innerText));
    // her open session is held: within a refresh or two the setup prompt appears over the sign-in page
    await person.waitFor(() => document.getElementById('mfa-dialog').open && /Set up two-step verification/.test(document.getElementById('mfa-form').innerText), undefined, { timeout: 20000 });
    assert.equal(await person.evaluate(() => document.getElementById('application').hidden), true);
    const secret = (await person.text('#mfa-secret')).replace(/\s/g, '');
    await person.fill('#mfa-code', codeAt(secret, -1)); await person.click('#mfa-submit');
    await person.waitFor(() => document.querySelectorAll('#mfa-form .mfa-codes li').length === 10);
    await person.click('#mfa-done');
    await person.waitFor(() => !document.getElementById('application').hidden);
    await openAccountMfa(person);
    assert.match(await person.text('#mfa-form'), /Yes, an administrator requires it/);
    assert.equal(await person.evaluate(() => document.querySelector('[data-mfa-action=disable]').disabled), true, 'turning it off is not offered while it is required');
    await person.click('#mfa-close');
    // the administrator sees she has it set up, resets it, and her session ends; the requirement stays
    await admin.evaluate(() => document.querySelector('#navigation button[data-view=overview]').click()); await openView(admin, 'users');
    await admin.waitFor(() => /pat\.policy · 2-step on/.test(document.getElementById('user-table').innerText), undefined, { timeout: 20000 });
    assert.deepEqual(await rowOf(), { select: 'true', state: 'Set up' });
    await admin.evaluate(() => [...document.querySelectorAll('[data-user-mfa-reset]')].find(button => /Pat Policy/.test(button.innerText)).click());
    await admin.waitFor(() => /Two-step verification reset for pat\.policy/.test(document.getElementById('notice').innerText));
    await person.waitFor(() => document.getElementById('login')?.getClientRects().length > 0, undefined, { timeout: 20000 });
    await signIn(person, user.username, user.password);
    await person.waitFor(() => document.getElementById('mfa-dialog').open && /Set up two-step verification/.test(document.getElementById('mfa-form').innerText));
    await person.close(); await admin.close();
  });
});
