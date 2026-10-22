// Builds apps/web/dark.css, the dark theme (docs/themes.md), from the console's three stylesheets.
//
// The light theme is the stylesheets as they are and is never touched. The dark theme is a second layer, scoped to html[data-theme="dark"], that repeats every colour declaration of
// every rule with the colours turned: pale surfaces become dark ones of the same hue, dark text becomes light text, pale borders become faint ones. Saturated colours (the teal of the
// buttons, the red of a failure) and everything that is already dark (the sidebar, the top bar) are left as they are. Because every colour declaration is repeated under the same prefix,
// the rules keep the same order and the same relative strength as in the light theme, so a state such as :hover or .active still beats the base rule it beats there.
//
//   node tools/build-dark-theme.js          writes apps/web/dark.css
//   node tools/build-dark-theme.js --check  fails when apps/web/dark.css is not what the stylesheets would give (run by the tests)
//
// What cannot be turned by a rule about colours (a chart, an unusual component) goes in apps/web/dark-tweaks.css, which is written by hand and loaded after dark.css.
import { readFile, writeFile } from 'node:fs/promises';

const webDir = new URL('../apps/web/', import.meta.url);
export const SOURCES = ['styles.css', 'visibility.css', 'vm-workspace.css'];
export const PREFIX = 'html[data-theme="dark"]';

// ---- colours ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
const COLOUR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)|\b(?:white|black|transparent)\b/g;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

export function parseColour(text) {
  const value = text.trim().toLowerCase();
  if (NAMED[value]) return [...NAMED[value]];
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length <= 4) hex = [...hex].map(char => char + char).join('');
    const channel = index => parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return [channel(0), channel(1), channel(2), hex.length === 8 ? Math.round(channel(3) / 255 * 1000) / 1000 : 1];
  }
  const match = /^rgba?\(([^)]*)\)$/.exec(value);
  if (!match) return null;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = part => (part.endsWith('%') ? parseFloat(part) * 2.55 : parseFloat(part));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  const rgb = parts.slice(0, 3).map(channel);
  return rgb.every(Number.isFinite) && Number.isFinite(alpha) ? [...rgb, alpha] : null;
}

const luminance = ([r, g, b]) => {
  const linear = channel => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), lightness = (max + min) / 2, delta = max - min;
  if (!delta) return { h: 0, s: 0, l: lightness };
  const s = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const h = max === r ? ((g - b) / delta + (g < b ? 6 : 0)) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: h * 60, s, l: lightness };
}

function fromHsl({ h, s, l }) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function format([r, g, b, a]) {
  const alpha = Math.round(a * 1000) / 1000;
  if (alpha >= 1) return `#${[r, g, b].map(channel => clamp(channel, 0, 255).toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${r},${g},${b},${String(alpha).replace(/^0\./, '.')})`;
}

// The hue the neutral surfaces of the dark theme lean towards, so that a grey becomes the console's blue-green slate rather than a flat grey.
const SLATE = { h: 196, s: 0.2 };
const PALE = 0.72;            // from this HSL lightness up a colour counts as pale

// A pale surface becomes a dark one of the same hue; the paler it was the darker it becomes; a tint (a pale red, a pale green) keeps its hue with less colour.
function darkSurface([r, g, b, a]) {
  const hsl = toHsl([r, g, b]), neutral = hsl.s < 0.12;
  const l = clamp(0.085 + (1 - hsl.l) * 0.42, 0.07, 0.3);
  const s = neutral ? SLATE.s : clamp(hsl.s * 0.55, 0.2, 0.55);
  return [...fromHsl({ h: neutral ? SLATE.h : hsl.h, s, l }), a];
}

// Dark text becomes light text of the same hue.
function lightText([r, g, b, a]) {
  const hsl = toHsl([r, g, b]), neutral = hsl.s < 0.12;
  const l = clamp(1 - hsl.l * 0.78, 0.68, 0.95);
  const s = neutral ? SLATE.s * 0.5 : clamp(hsl.s * 0.85, 0.3, 0.8);
  return [...fromHsl({ h: neutral ? SLATE.h : hsl.h, s, l }), a];
}

// A pale border becomes a faint one.
function darkBorder([r, g, b, a]) {
  const hsl = toHsl([r, g, b]), neutral = hsl.s < 0.12;
  const l = clamp(0.17 + (1 - hsl.l) * 0.5, 0.17, 0.34);
  const s = neutral ? SLATE.s : clamp(hsl.s * 0.5, 0.15, 0.5);
  return [...fromHsl({ h: neutral ? SLATE.h : hsl.h, s, l }), a];
}

// kind: surface | text | border | shadow | stroke | fill
export function turn(colour, kind) {
  const [r, g, b, a] = colour;
  if (a < 0.05) return colour;
  const y = luminance(colour), pale = toHsl(colour).l >= PALE;       // pale means light in hue-saturation-lightness terms: a bright but saturated cyan is not a pale surface
  if (kind === 'surface') {
    if (r >= 235 && g >= 235 && b >= 235 && a <= 0.25) return colour;       // a faint white sheen on a dark panel is already right
    return pale ? darkSurface(colour) : colour;
  }
  if (kind === 'text') return y < 0.4 ? lightText(colour) : colour;
  if (kind === 'border') return pale ? darkBorder(colour) : colour;
  if (kind === 'stroke') return pale ? darkBorder(colour) : y < 0.4 ? lightText(colour) : colour;       // a light line (a chart's grid) turns faint, a dark one turns light
  if (kind === 'fill') return pale ? darkSurface(colour) : y < 0.4 ? lightText(colour) : colour;
  if (kind === 'shadow') return r >= 235 && g >= 235 && b >= 235 && a > 0.12 ? [255, 255, 255, 0.06] : colour;
  return colour;
}

export const luminanceOf = luminance;

// ---- which declarations are colours -----------------------------------------------------------------------------------------------------------------------------
const KIND = property => {
  if (/^background(-color|-image)?$/.test(property)) return 'surface';
  if (property === 'stroke') return 'stroke';
  if (property === 'fill') return 'fill';
  if (['color', 'caret-color', 'text-decoration-color', '-webkit-text-fill-color', 'text-emphasis-color'].includes(property)) return 'text';
  if ((property.startsWith('border') && !/(width|style|radius|spacing|collapse|image)/.test(property)) || /^outline(-color)?$/.test(property) || property === 'column-rule' || property === 'column-rule-color') return 'border';
  if (property === 'box-shadow' || property === 'text-shadow') return 'shadow';
  return null;
};
// A custom property holds a colour of whatever kind its name says.
const customKind = name => (/(text|muted|ink|foreground|fg)/.test(name) ? 'text' : /(line|border|outline)/.test(name) ? 'border' : /(glass|surface|panel|card|paper|bg|background|field)/.test(name) ? 'surface' : /shadow/.test(name) ? 'shadow' : null);

function turnValue(value, kind, retainedLightBackground) {
  if (kind === 'text' && retainedLightBackground) return value;
  if (kind === 'text') value = value.replaceAll('var(--teal)', 'var(--teal-ink)');       // the teal of the buttons is too dim to read as text on a dark panel; dark-tweaks.css defines the lighter one
  return value.replace(COLOUR, text => { const colour = parseColour(text); return colour ? format(turn(colour, kind)) : text; });
}

// ---- a small CSS reader -------------------------------------------------------------------------------------------------------------------------------------------------
// Enough CSS for the console's three files: rules, nested @media and @supports, @keyframes and @font-face (which are skipped), comments and strings.
function skipString(text, index) { const quote = text[index]; index++; while (index < text.length && text[index] !== quote) index += text[index] === '\\' ? 2 : 1; return index + 1; }
function skipComment(text, index) { const end = text.indexOf('*/', index + 2); return end < 0 ? text.length : end + 2; }

// Splits `text` at top-level occurrences of `separator` (not inside brackets, parentheses or strings).
function splitTop(text, separator) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") { i = skipString(text, i) - 1; continue; }
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

export function parseCss(text) {
  let index = 0;
  const parseBlock = (insideAtRule) => {
    const nodes = [];
    for (;;) {
      while (index < text.length && /\s/.test(text[index])) index++;
      if (text.startsWith('/*', index)) { index = skipComment(text, index); continue; }
      if (index >= text.length) { if (insideAtRule) throw new Error('a block is never closed'); return nodes; }
      if (text[index] === '}') { if (!insideAtRule) throw new Error(`a stray } at ${index}`); index++; return nodes; }
      // the prelude: up to { or ;
      const start = index;
      let depth = 0;
      for (; index < text.length; index++) {
        const char = text[index];
        if (char === '"' || char === "'") { index = skipString(text, index) - 1; continue; }
        if (char === '/' && text[index + 1] === '*') { index = skipComment(text, index) - 1; continue; }
        if (char === '(' || char === '[') depth++;
        else if (char === ')' || char === ']') depth--;
        else if ((char === '{' || char === ';' || char === '}') && depth === 0) break;
      }
      const prelude = text.slice(start, index).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (text[index] === ';') { index++; continue; }
      if (text[index] !== '{') { if (!insideAtRule) return nodes; index++; return nodes; }
      index++;
      if (prelude.startsWith('@')) {
        const name = /^@([a-z-]+)/i.exec(prelude)[1].toLowerCase();
        if (['media', 'supports', 'layer', 'container'].includes(name)) nodes.push({ type: 'at', prelude, children: parseBlock(true) });
        else skipBlock();
      } else {
        const bodyStart = index; skipBlock(); nodes.push({ type: 'rule', selector: prelude, body: text.slice(bodyStart, index - 1) });
      }
    }
  };
  function skipBlock() {
    let depth = 1;
    while (index < text.length && depth) {
      const char = text[index];
      if (char === '"' || char === "'") { index = skipString(text, index); continue; }
      if (char === '/' && text[index + 1] === '*') { index = skipComment(text, index); continue; }
      if (char === '{') depth++; else if (char === '}') depth--;
      index++;
    }
    if (depth) throw new Error('a block is never closed');
  }
  return parseBlock(false);
}

export const declarations = body => splitTop(body.replace(/\/\*[\s\S]*?\*\//g, ''), ';').map(part => part.trim()).filter(Boolean).map(part => {
  const colon = part.indexOf(':');
  if (colon < 0) return null;
  const property = part.slice(0, colon).trim().toLowerCase(), raw = part.slice(colon + 1).trim(), important = /!\s*important\s*$/i.test(raw);
  return { property, value: raw.replace(/\s*!\s*important\s*$/i, ''), important };
}).filter(Boolean);

// ---- the dark rules -------------------------------------------------------------------------------------------------------------------------------------------------------
function prefixSelector(selector) {
  return splitTop(selector, ',').map(part => part.trim()).filter(Boolean).map(part => {
    const root = /^(:root|html)(?![\w-])/.exec(part);
    return root ? `${PREFIX}${part.slice(root[0].length)}` : `${PREFIX} ${part}`;
  }).join(',');
}

function darkDeclarations(body) {
  const list = declarations(body);
  // A rule that sets a pale background of its own which stays pale (a bright button) keeps its dark text.
  const retainedLightBackground = list.some(item => {
    if (KIND(item.property) !== 'surface') return false;
    const first = (item.value.match(COLOUR) ?? []).map(parseColour).find(colour => colour && colour[3] >= 0.5);
    return first ? luminance(first) > 0.3 && turn(first, 'surface') === first : false;
  });
  const out = [];
  for (const item of list) {
    const kind = item.property.startsWith('--') ? customKind(item.property) : KIND(item.property);
    if (!kind && !item.property.startsWith('--')) continue;
    if (item.property.startsWith('--') && !COLOUR.test(item.value)) { COLOUR.lastIndex = 0; continue; }
    COLOUR.lastIndex = 0;
    const value = kind ? turnValue(item.value, kind, retainedLightBackground) : item.value;
    out.push(`${item.property}:${value}${item.important ? '!important' : ''}`);
  }
  return out;
}

function emit(nodes, indent = '') {
  const lines = [];
  for (const node of nodes) {
    if (node.type === 'at') {
      const inner = emit(node.children, `${indent}  `);
      if (inner.length) lines.push(`${indent}${node.prelude}{`, ...inner, `${indent}}`);
    } else {
      const list = darkDeclarations(node.body);
      if (list.length) lines.push(`${indent}${prefixSelector(node.selector)}{${list.join(';')}}`);
    }
  }
  return lines;
}

export function buildDarkCss(sources) {
  const header = ['/* The dark theme (docs/themes.md). GENERATED by tools/build-dark-theme.js from styles.css, visibility.css and vm-workspace.css: do not edit it; change the generator,',
    '   or put a hand-made fix in dark-tweaks.css, then run `node tools/build-dark-theme.js`. Every colour declaration of the light theme is repeated here with its colours turned,',
    '   under html[data-theme="dark"], so the rules keep the order and the strength they have in the light theme. */'];
  const body = [];
  for (const [name, text] of sources) body.push(`/* from ${name} */`, ...emit(parseCss(text)));
  return `${[...header, ...body].join('\n')}\n`;
}

async function main() {
  const sources = await Promise.all(SOURCES.map(async name => [name, await readFile(new URL(name, webDir), 'utf8')]));
  const css = buildDarkCss(sources);
  const target = new URL('dark.css', webDir);
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== css) { console.error('apps/web/dark.css is not what the stylesheets give; run `node tools/build-dark-theme.js`'); process.exitCode = 1; }
    else console.log('apps/web/dark.css is up to date');
    return;
  }
  await writeFile(target, css);
  console.log(JSON.stringify({ status: 'written', file: 'apps/web/dark.css', bytes: Buffer.byteLength(css), rules: css.split('\n').length }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
