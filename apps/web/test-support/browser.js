import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// A small browser driver for the console's end-to-end tests. It starts the system Chrome without a window and talks to it over the DevTools protocol using the `ws`
// package the product already depends on, so the tests need no browser download and no extra test framework. Chrome is looked up in NUVRION_CHROME, then in the usual
// places; when there is none the browser tests skip (and fail instead when NUVRION_REQUIRE_BROWSER_TESTS=1, as CI sets).
const CANDIDATES = [process.env.NUVRION_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
export const findChrome = () => CANDIDATES.find(path => existsSync(path)) ?? null;
export const browserTestsRequired = () => process.env.NUVRION_REQUIRE_BROWSER_TESTS === '1';
export async function browserSkipReason() {
  if (!findChrome()) return browserTestsRequired() ? null : 'Chrome was not found (set NUVRION_CHROME, or NUVRION_REQUIRE_BROWSER_TESTS=1 to make this an error)';
  const dependencies = await Promise.all(['ws', 'pg', 'ssh2', 'amqplib', 'axe-core'].map(name => import(name).then(() => true, () => false)));
  return dependencies.every(Boolean) ? null : 'the declared dependencies are not installed (npm ci)';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEYS = { Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 } };

export async function launchBrowser({ width = 1366, height = 900 } = {}) {
  const { default: WebSocket } = await import('ws');
  const profile = mkdtempSync(join(tmpdir(), 'nuvrion-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--force-device-scale-factor=1', `--window-size=${width},${height}`, ...(process.env.CI || process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'];
  const chrome = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; chrome.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1500); });
  // A shared CI runner that is busy with other test files can take far longer than ten seconds to start Chrome. Wait up to a minute, and stop at once if Chrome has quit.
  let port = null, path = null;
  for (let i = 0; i < 1200 && !port; i++) {
    await sleep(50);
    if (chrome.exitCode !== null) throw new Error(`Chrome quit while starting (exit code ${chrome.exitCode}): ${errors.trim().split('\n').slice(-5).join(' | ')}`);
    try { [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'); } catch { /* not written yet */ }
  }
  if (!port) { chrome.kill(); rmSync(profile, { recursive: true, force: true }); throw new Error(`Chrome did not start within a minute: ${errors.trim().split('\n').slice(-5).join(' | ')}`); }
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let nextId = 0; const waiting = new Map(), listeners = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id && waiting.has(message.id)) { const { resolve, reject } = waiting.get(message.id); waiting.delete(message.id); message.error ? reject(new Error(`${message.error.message} (${message.error.data ?? ''})`)) : resolve(message.result); }
    else if (message.method) for (const listener of listeners) listener(message);
  });
  socket.on('close', () => { for (const { reject } of waiting.values()) reject(new Error('the browser closed the connection')); waiting.clear(); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

  async function newPage() {
    const { browserContextId } = await send('Target.createBrowserContext');          // each page gets its own cookies and storage, like a separate private window
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const problems = [], dialogs = []; let loaded = null, answer = true;     // native alert/confirm/prompt boxes are recorded and answered (accepted unless `page.dismissDialogs()`)
    listeners.push(message => {
      if (message.sessionId !== sessionId) return;
      const { method, params } = message;
      if (method === 'Page.loadEventFired') loaded?.();
      if (method === 'Page.javascriptDialogOpening') { dialogs.push({ type: params.type, message: params.message, ...(params.type === 'prompt' ? { defaultValue: params.defaultPrompt } : {}) }); call('Page.handleJavaScriptDialog', { accept: answer }); }
      if (method === 'Runtime.exceptionThrown') problems.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') problems.push(`console.error: ${params.args.map(a => a.value ?? a.description).join(' ')}`);
      if (method === 'Log.entryAdded' && params.entry.level === 'error') problems.push(`log: ${params.entry.text} ${params.entry.url ?? ''}`);
      if (method === 'Network.loadingFailed' && !params.canceled) problems.push(`request failed: ${params.errorText}`);
    });
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await call(`${domain}.enable`);
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    const page = {
      problems: () => problems.splice(0),
      dialogs: () => dialogs.splice(0),
      async waitForDialog(timeout = 8000) {                        // wait for a native alert/confirm/prompt box and return everything shown so far
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) { if (dialogs.length) return dialogs.splice(0); await sleep(25); }
        throw new Error('no dialog box appeared');
      },
      dismissDialogs: () => { answer = false; },
      async goto(url) { const done = new Promise(resolve => { loaded = resolve; }); await call('Page.navigate', { url }); await Promise.race([done, sleep(15000).then(() => { throw new Error(`${url} did not finish loading`); })]); },
      async reload() { const done = new Promise(resolve => { loaded = resolve; }); await call('Page.reload'); await done; },
      async evaluate(fn, ...args) {
        const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
        const { result, exceptionDetails } = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (exceptionDetails) throw new Error(`in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
        return result.value;
      },
      async waitFor(fn, ...args) {
        const options = typeof args.at(-1) === 'object' && args.at(-1) !== null && 'timeout' in args.at(-1) ? args.pop() : {};
        const deadline = Date.now() + (options.timeout ?? 8000);
        let last;
        while (Date.now() < deadline) { last = await page.evaluate(fn, ...args); if (last) return last; await sleep(25); }
        const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
        throw new Error(`timed out waiting for ${typeof fn === 'function' ? fn.toString().slice(0, 160) : fn}; the page shows: ${body}`);
      },
      // Where to click: scrolled into view, and not moving (menus and panels animate, and a click at a position that is about to change lands on the wrong control).
      async point(selector) {
        const read = selector => { const e = document.querySelector(selector); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); const visible = r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; return visible ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: Boolean(e.disabled) } : null; };
        let previous = null;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const now = await page.evaluate(read, selector);
          if (now && previous && now.x === previous.x && now.y === previous.y) return now;
          previous = now; await sleep(60);
        }
        const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
        throw new Error(`${selector} did not become visible and still; the page shows: ${body}`);
      },
      async click(selector) {
        const { x, y, disabled } = await page.point(selector);
        if (disabled) throw new Error(`${selector} is disabled`);
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      },
      // Click the visible button or link in `scope` whose text contains `text`, the way a person looks for it.
      async clickText(text, scope = 'body') {
        const marker = `data-e2e-${Math.random().toString(36).slice(2)}`;
        await page.waitFor((text, scope, marker) => {
          const found = [...document.querySelectorAll(`${scope} button, ${scope} a, ${scope} [role=button], ${scope} [role=tab]`)].find(e => e.textContent.replace(/\s+/g, ' ').includes(text) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
          if (!found) return false; found.setAttribute(marker, ''); return true;
        }, text, scope, marker);
        await page.click(`[${marker}]`);
        await page.evaluate(marker => document.querySelector(`[${marker}]`)?.removeAttribute(marker), marker);
      },
      async fill(selector, text) {
        await page.point(selector);
        await page.evaluate(selector => { const e = document.querySelector(selector); e.focus(); e.select?.(); }, selector);
        if (text === '') await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }), await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        else await call('Input.insertText', { text });
      },
      async press(name) {
        const key = KEYS[name];
        await call('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...key });
        await call('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode });
      },
      async pressWithShift(name) {
        const key = KEYS[name];
        await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 8, ...key });
        await call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode });
      },
      text: selector => page.evaluate(selector => document.querySelector(selector)?.innerText ?? null, selector),
      visible: selector => page.evaluate(selector => { const e = document.querySelector(selector); return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); }, selector),
      setViewport: (w, h) => call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 }),
      cookies: async () => (await call('Network.getCookies')).cookies,
      async axe(context = null, tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']) {
        await page.evaluate(axeSource);
        return page.evaluate(async (context, tags) => {
          const result = await window.axe.run(context ? document.querySelector(context) : document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
          return result.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 5).map(n => n.target.join(' ')) }));
        }, context, tags);
      },
      async close() { await send('Target.closeTarget', { targetId }).catch(() => {}); await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); }
    };
    return page;
  }

  return {
    newPage,
    async close() {
      await Promise.race([send('Browser.close').catch(() => {}), sleep(1500)]);        // Chrome closes the connection instead of answering
      socket.close(); chrome.kill();
      await sleep(100); rmSync(profile, { recursive: true, force: true });
    }
  };
}
