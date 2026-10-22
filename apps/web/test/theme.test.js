import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CHOICES, THEME_KEY, normaliseChoice, resolveTheme, choiceHtml, choiceHint } from '../theme.js';

test('anything that is not a known choice is "system"; a known one is kept', () => {
  for (const choice of CHOICES) assert.equal(normaliseChoice(choice), choice);
  for (const value of [null, undefined, '', 'Dark', 'blue', 42, {}]) assert.equal(normaliseChoice(value), 'system');
});

test('light and dark are what they say; "system" follows the device', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('nonsense', true), 'dark', 'an unknown choice behaves as "system"');
});

test('the account menu offers the three choices and marks the one in use as pressed', () => {
  const html = choiceHtml('dark');
  assert.equal([...html.matchAll(/data-theme-choice="(\w+)"/g)].map(match => match[1]).join(), 'system,light,dark');
  assert.match(html, /data-theme-choice="dark" aria-pressed="true"/);
  assert.match(html, /data-theme-choice="light" aria-pressed="false"/);
  assert.match(choiceHint('system', 'dark'), /Following this device \(dark now\)/);
  assert.equal(choiceHint('light', 'light'), 'Light theme');
});

// theme-boot.js runs before the page is painted and cannot import theme.js, so it repeats the rule; here it is run in every situation and held to resolveTheme.
function boot({ stored, prefersDark, storageThrows = false }) {
  const attributes = {};
  const sandbox = {
    localStorage: { getItem: key => { if (storageThrows) throw new Error('blocked'); assert.equal(key, THEME_KEY); return stored ?? null; } },
    window: { matchMedia: query => { assert.equal(query, '(prefers-color-scheme: dark)'); return { matches: prefersDark }; } },
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } }
  };
  vm.runInNewContext(readFileSync(new URL('../theme-boot.js', import.meta.url), 'utf8'), sandbox);
  return attributes['data-theme'];
}

test('theme-boot.js picks the same theme as theme.js in every situation', () => {
  for (const stored of [undefined, 'system', 'light', 'dark', 'garbage']) {
    for (const prefersDark of [false, true]) assert.equal(boot({ stored, prefersDark }), resolveTheme(normaliseChoice(stored), prefersDark), `stored ${stored}, device dark ${prefersDark}`);
  }
});

test('theme-boot.js still sets a theme when the browser blocks storage', () => {
  assert.equal(boot({ storageThrows: true, prefersDark: true }), 'dark');
  assert.equal(boot({ storageThrows: true, prefersDark: false }), 'light');
});
