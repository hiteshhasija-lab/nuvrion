import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkipReason, launchBrowser } from '../../test-support/browser.js';
import { startConsole, ADMIN_PASSWORD } from '../../test-support/lab.js';

// End-to-end tests of the console in a real browser: the real API and web files run in-process with in-memory services and the mock provider, Chrome drives the
// pages the way a person would (typing, clicking, pressing keys), and each test checks what the person would see. They need Chrome (NUVRION_CHROME, or the usual
// locations); without it they skip, and CI sets NUVRION_REQUIRE_BROWSER_TESTS=1 so that a missing browser is a failure there.
const NEW_PASSWORD = 'A-Long-Enough-Password-3!', DIFFERENT_PASSWORD = 'A-Different-Password-4!';   // secret-scan:allow (fake test credentials)
const skip = await browserSkipReason();
const EXPECTED_BEFORE_SIGN_IN = /\/api\/v1\/auth\/me/;   // the page asks who is signed in before anyone is, and Chrome logs the 401 it gets
const unexpected = problems => problems.filter(p => !EXPECTED_BEFORE_SIGN_IN.test(p));

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
});
