import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkipReason, launchBrowser } from '../../test-support/browser.js';
import { ADMIN_PASSWORD, startConsole } from '../../test-support/lab.js';
import { exitWhenIdle } from '../../test-support/exit-guard.js';

// When the console fetches the machine list (apps/web/refresh-policy.js), in a real browser. The list once went over the network every second; it now goes every half minute, and
// at once when there is a reason. These tests check both halves: that it is quiet when nothing happens, and that nothing a person waits for got slower than they would notice.
const skip = await browserSkipReason();

describe('how often the console fetches the machine list', { skip: skip ?? false }, () => {
  let lab, browser;
  before(async () => { lab = await startConsole(); browser = await launchBrowser(); });
  after(async () => { await browser?.close(); await lab?.close(); exitWhenIdle(); });

  const signedInPage = async () => {
    const page = await browser.newPage(); await page.goto(lab.url);
    for (let attempt = 1; ; attempt++) {                       // a click on "Sign in" is sometimes lost on a slow runner (see console.e2e.test.js)
      await page.fill('#login-form [name=username]', 'admin'); await page.fill('#login-form [name=password]', ADMIN_PASSWORD);
      await page.clickText('Sign in →', '#login-form');
      try { await page.waitFor(() => document.querySelectorAll('#view-inventory tbody tr').length === 2, { timeout: attempt < 3 ? 8000 : 20000 }); return page; } catch (error) { if (attempt === 3) throw error; console.error(`e2e: sign-in attempt ${attempt} had no effect; trying again`); }
    }
  };
  const startCounting = page => page.evaluate(() => { performance.setResourceTimingBufferSize(2000); performance.clearResourceTimings(); });
  const counted = page => page.evaluate(() => {
    const paths = performance.getEntriesByType('resource').map(entry => new URL(entry.name)).filter(url => url.pathname.startsWith('/api/v1/'));
    return { list: paths.filter(url => url.pathname === '/api/v1/resources').length, measurements: paths.filter(url => url.pathname === '/api/v1/performance/latest').length, tasks: paths.filter(url => url.pathname === '/api/v1/tasks').length };
  });
  const sleep = (page, ms) => page.evaluate(time => new Promise(resolve => setTimeout(resolve, time)), ms);
  const machine = async name => (await lab.api('GET', '/api/v1/resources?resourceType=virtual_machine')).json.items.find(item => item.name === name);
  const rowText = (page, name) => page.evaluate(wanted => [...document.querySelectorAll('#view-inventory tbody tr')].find(row => row.textContent.includes(wanted))?.textContent ?? '', name);
  const rowHas = (page, name, text, timeout) => page.waitFor((wanted, expected) => [...document.querySelectorAll('#view-inventory tbody tr')].find(row => row.textContent.includes(wanted))?.textContent.includes(expected), name, text, { timeout });

  test('a console that is left alone keeps asking for tasks every five seconds and leaves the machine list alone', async () => {
    const page = await signedInPage();
    await sleep(page, 1500);
    await startCounting(page);
    await sleep(page, 16000);
    const seen = await counted(page);
    assert.ok(seen.tasks >= 3, `the five-second refresh goes on: ${JSON.stringify(seen)}`);
    assert.ok(seen.list <= 1, `the machine list was fetched ${seen.list} times in 16 seconds (it used to be about 16)`);
    assert.ok(seen.measurements <= 1, `the performance numbers were fetched ${seen.measurements} times in 16 seconds`);
    await page.close();
  });

  // The list is what is checked, not the machine's state on screen: the lab's mock provider reports the same inventory at every discovery, so a few seconds after the operation the
  // machine reads as it did before (a real provider reports what is true).
  test('an operation started somewhere else makes the console fetch the list at its next refresh, not after half a minute', async () => {
    const page = await signedInPage();
    const target = await machine('nuvrion-db-01');
    await sleep(page, 1500);
    await startCounting(page);
    await sleep(page, 5500);
    assert.equal((await counted(page)).list, 0, 'nothing has happened, so the list is not fetched');
    const started = Date.now();
    const accepted = await lab.api('POST', `/api/v1/resources/${target.id}/operations`, { operation: 'start' }, { 'idempotency-key': `refresh-test-${started}` });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
    await page.waitFor(() => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname === '/api/v1/resources'), { timeout: 7500 });
    assert.ok(Date.now() - started < 7500, 'one five-second refresh, with room for a slow runner');
    await page.close();
  });

  test('a change that nothing announces still arrives by itself within the half minute', async () => {
    const page = await signedInPage();
    const target = await machine('nuvrion-app-01');
    assert.equal((await rowText(page, 'nuvrion-app-01')).includes('quietly'), false);
    assert.equal((await lab.api('POST', '/api/v1/tag-operations', { resourceIds: [target.id], set: [{ key: 'changed', value: 'quietly' }] })).status, 200);
    await rowHas(page, 'nuvrion-app-01', 'quietly', 45000);          // no task and no change of health: only the half-minute fetch can bring it
    await page.close();
  });

  test('opening a page after a few seconds shows what is true now', async () => {
    const page = await signedInPage();
    const target = await machine('nuvrion-app-01');
    assert.equal((await lab.api('POST', '/api/v1/tag-operations', { resourceIds: [target.id], set: [{ key: 'opened', value: 'afresh' }] })).status, 200);
    await sleep(page, 6000);
    await startCounting(page);
    await page.click('#navigation button[data-view=overview]');
    await page.click('#navigation button[data-view=inventory]');
    await rowHas(page, 'nuvrion-app-01', 'afresh', 4000);
    assert.ok((await counted(page)).list >= 1);
    await page.close();
  });
});
