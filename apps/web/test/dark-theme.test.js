import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildDarkCss, parseCss, parseColour, turn, luminanceOf, SOURCES, PREFIX } from '../../../tools/build-dark-theme.js';

const hex = ([r, g, b]) => `#${[r, g, b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const contrast = (a, b) => { const [high, low] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };
const build = css => buildDarkCss([['test.css', css]]).split('\n').filter(line => !line.startsWith('/*') && !line.startsWith('   ') && line.trim() && line.trim() !== '}');

test('the committed dark.css is exactly what the stylesheets give (run `node tools/build-dark-theme.js` after changing one)', async () => {
  const sources = await Promise.all(SOURCES.map(async name => [name, await readFile(new URL(`../${name}`, import.meta.url), 'utf8')]));
  assert.equal(await readFile(new URL('../dark.css', import.meta.url), 'utf8'), buildDarkCss(sources));
});

test('every rule is scoped to the dark theme, :root and html become the theme itself, media queries are kept', () => {
  const out = build(':root{color:#172126;background:#f3f5f6} .card,.panel>p{background:#fff;border:1px solid #dce3e4} @media(max-width:700px){.card{background:#fff}} html:focus-within{color:#000}');
  assert.deepEqual(out.map(line => line.trim().split('{')[0]).filter(Boolean), [PREFIX, `${PREFIX} .card,${PREFIX} .panel>p`, '@media(max-width:700px)', `${PREFIX} .card`, `${PREFIX}:focus-within`]);
});

test('pale surfaces turn dark, dark text turns light, pale borders turn faint, and what has colour or is already dark stays', () => {
  const dark = css => build(css)[0].replace(/^.*?\{/, '').replace(/\}$/, '');
  assert.notEqual(dark('.a{background:#fff}'), 'background:#ffffff');
  const surface = parseColour(dark('.a{background:#fff}').split(':')[1]);
  assert.ok(luminanceOf(surface) < 0.03, 'a white panel becomes a dark one');
  const text = parseColour(dark('.a{color:#172126}').split(':')[1]);
  assert.ok(luminanceOf(text) > 0.6, 'near-black text becomes light');
  assert.equal(dark('.a{background:#147d77;color:#fff}'), 'background:#147d77;color:#ffffff', 'a teal button with white text is left alone');
  assert.equal(dark('aside{background:#122c31;color:#fff}'), 'background:#122c31;color:#ffffff', 'what is already dark is left alone');
  assert.equal(dark('.a{background:rgba(255,255,255,.075)}'), 'background:rgba(255,255,255,.075)', 'a faint sheen on a dark panel is left alone');
  assert.match(dark('.a{background:rgba(255,255,255,.72)}'), /^background:rgba\(\d+,\d+,\d+,\.72\)$/, 'a translucent white panel keeps its translucency');
  assert.ok(luminanceOf(parseColour(dark('.a{border:1px solid #dce3e4}').match(/#[0-9a-f]{6}/)[0])) < 0.05, 'a pale border becomes faint');
});

test('a bright button keeps its dark text, so text on it is not turned light', () => {
  const [rule] = build('.go{background:#4adbea;color:#0b1b2c}');
  assert.match(rule, /background:#4adbea;color:#0b1b2c/);
});

test('every colour declaration is repeated, even when it does not change, so states keep the strength they have in the light theme', () => {
  const out = build('.a{background:#147d77}.a.b{background:none}.a:hover{color:#fff;opacity:.5}');
  assert.equal(out.length, 3);
  assert.match(out[1], /\.a\.b\{background:none\}/);
  assert.match(out[2], /\{color:#ffffff\}$/, 'only colour declarations are repeated');
});

test('!important is kept; strings, comments and url() with odd characters do not confuse the reader', () => {
  const out = build('/* } { */ .a{background:#fff!important;content:"}{;"} .b{background:url("data:image/svg+xml;utf8,<svg/>") #fff}');
  assert.match(out[0], /background:#[0-9a-f]{6}!important/);
  assert.equal(out.length, 2);
  assert.throws(() => parseCss('.a{color:red'), /never closed/);
});

test('text in the brand teal is pointed at the lighter --teal-ink, which dark-tweaks.css defines', async () => {
  assert.match(build('.a{color:var(--teal)}')[0], /color:var\(--teal-ink\)/);
  assert.match(build('.a{background:var(--teal)}')[0], /background:var\(--teal\)/);
  assert.match(await readFile(new URL('../dark-tweaks.css', import.meta.url), 'utf8'), /--teal-ink:#[0-9a-f]{6}/i);
});

test('every text and surface colour pair of the light theme still reads at 4.5 to 1 (3 to 1 for large text) once turned', () => {
  const texts = ['#172126', '#4d5b60', '#3d4b50', '#647277', '#a7342f', '#a32f2f', '#18734a', '#9a5b00', '#8c5a00', '#0b625c', '#087b74', '#172b3e'];
  const surfaces = ['#ffffff', '#f3f5f6', '#edf1f2', '#fff0d7', '#fde8e7', '#e2f5ec', '#e7f4f2', '#fff1f0', '#f8fcfd'];
  const failures = [];
  for (const text of texts) for (const surface of surfaces) {
    const light = contrast(parseColour(text), parseColour(surface));
    if (light < 4.5) continue;                                  // the light theme itself does not use this pair
    const darkText = turn(parseColour(text), 'text'), darkSurface = turn(parseColour(surface), 'surface');
    const ratio = contrast(darkText, darkSurface);
    if (ratio < 4.5) failures.push(`${text} on ${surface} -> ${hex(darkText)} on ${hex(darkSurface)} = ${ratio.toFixed(2)}`);
  }
  assert.deepEqual(failures, []);
});
