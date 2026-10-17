// A QR code encoder for the enrolment link of two-factor sign-in (docs/mfa.md). The secret is drawn here, in the browser, so it never goes to a third-party service to be
// turned into a picture. Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes), which is far more than an otpauth:// link needs. Pure functions, kept apart
// from app.js so they can be tested in node: apps/web/test/qr.test.js reads a code back (format, codewords, error correction) rather than trusting the encoder.

// [version]: [ec codewords per block, [[blocks, data codewords per block], ...]] for level M
const BLOCKS = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]]
};
const ALIGNMENT = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
export const MAX_VERSION = 10;
const FORMAT_LEVEL_M = 0b00;

// ---- Reed-Solomon over GF(256), polynomial 0x11D --------------------------------------------------------------------------------------------------------------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const multiply = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    poly.forEach((coefficient, j) => { next[j] ^= coefficient; next[j + 1] ^= multiply(coefficient, EXP[i]); });
    poly = next;
  }
  return poly;
}

export function reedSolomon(data, degree) {
  const gen = generator(degree), result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    if (factor) gen.slice(1).forEach((coefficient, i) => { result[i] ^= multiply(coefficient, factor); });
  }
  return result;
}

// ---- data ----------------------------------------------------------------------------------------------------------------------------------------------------------------
const dataCapacity = version => BLOCKS[version][1].reduce((sum, [blocks, size]) => sum + blocks * size, 0);
const countBits = version => (version < 10 ? 8 : 16);

export function chooseVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version++) if (4 + countBits(version) + 8 * byteLength <= 8 * dataCapacity(version)) return version;
  throw new Error('NUV_QR_TOO_LONG');
}

function dataCodewords(bytes, version) {
  const bits = [], push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, countBits(version)); for (const byte of bytes) push(byte, 8);
  const capacity = 8 * dataCapacity(version);
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const words = []; for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < dataCapacity(version); pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

function interleave(words, version) {
  const [ecPerBlock, groups] = BLOCKS[version], blocks = [];
  let at = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) { const data = words.slice(at, at + size); at += size; blocks.push({ data, ec: reedSolomon(data, ecPerBlock) }); }
  const out = [], longest = Math.max(...blocks.map(block => block.data.length));
  for (let i = 0; i < longest; i++) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

// ---- the matrix ----------------------------------------------------------------------------------------------------------------------------------------------------------
const sizeOf = version => 17 + 4 * version;

function bchFormat(maskNumber) {
  const data = (FORMAT_LEVEL_M << 3) | maskNumber;
  let remainder = data << 10;
  for (let i = 14; i >= 10; i--) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  return ((data << 10) | remainder) ^ 0x5412;
}

function bchVersion(version) {
  let remainder = version << 12;
  for (let i = 17; i >= 12; i--) if ((remainder >>> i) & 1) remainder ^= 0x1f25 << (i - 12);
  return (version << 12) | remainder;
}

function blank(version) {
  const size = sizeOf(version), modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (row, column, dark) => { if (row >= 0 && row < size && column >= 0 && column < size) modules[row][column] = dark; };
  const finder = (row, column) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6, dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(row + r, column + c, dark);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const centres = ALIGNMENT[version];
  const first = centres[0], last = centres[centres.length - 1];
  for (const row of centres) for (const column of centres) {
    if ((row === first && column === first) || (row === first && column === last) || (row === last && column === first)) continue;   // those three would sit on a finder pattern
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(row + r, column + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
  }
  set(size - 8, 8, true);                          // the dark module
  const reserved = modules.map(row => row.map(value => value !== null));
  const reserve = (row, column) => { reserved[row][column] = true; };
  for (let i = 0; i < 9; i++) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i++) { reserve(8, size - 1 - i); reserve(size - 1 - i, 8); }
  if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserve(i, size - 11 + j); reserve(size - 11 + j, i); }
  return { size, modules, reserved };
}

function placeVersion(modules, version) {
  if (version < 7) return;
  const size = modules.length, info = bchVersion(version);
  for (let i = 0; i < 18; i++) { const dark = ((info >>> i) & 1) === 1, a = Math.floor(i / 3), b = (i % 3) + size - 11; modules[a][b] = dark; modules[b][a] = dark; }
}

function placeFormat(modules, maskNumber) {
  const size = modules.length, info = bchFormat(maskNumber), bit = i => ((info >>> i) & 1) === 1;
  for (let i = 0; i < 6; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6); modules[8][8] = bit(7); modules[8][7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function placeData(modules, reserved, codewords, maskNumber) {
  const size = modules.length, mask = MASKS[maskNumber], bits = [];
  for (const word of codewords) for (let i = 7; i >= 0; i--) bits.push((word >>> i) & 1);
  let at = 0, upward = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [column, column - 1]) {
        if (reserved[row][c]) continue;
        const bit = at < bits.length ? bits[at] === 1 : false; at += 1;
        modules[row][c] = mask(row, c) ? !bit : bit;
      }
    }
    upward = !upward;
  }
}

function penalty(modules) {
  const size = modules.length; let score = 0;
  const runs = line => { let total = 0, run = 1; for (let i = 1; i < line.length; i++) { if (line[i] === line[i - 1]) run += 1; else { if (run >= 5) total += run - 2; run = 1; } } return total + (run >= 5 ? run - 2 : 0); };
  for (let i = 0; i < size; i++) { score += runs(modules[i]); score += runs(modules.map(row => row[i])); }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const v = modules[r][c]; if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3; }
  const pattern = [true, false, true, true, true, false, true, false, false, false, false], reverse = [...pattern].reverse();
  const finders = line => { let total = 0; for (let i = 0; i + 11 <= line.length; i++) if (pattern.every((v, k) => line[i + k] === v) || reverse.every((v, k) => line[i + k] === v)) total += 40; return total; };
  for (let i = 0; i < size; i++) { score += finders(modules[i]); score += finders(modules.map(row => row[i])); }
  const dark = modules.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// text -> { version, size, modules: boolean[][] (true = dark), mask }
export function encode(text) {
  const bytes = new TextEncoder().encode(String(text)), version = chooseVersion(bytes.length);
  const codewords = interleave(dataCodewords(bytes, version), version);
  let best = null;
  for (let maskNumber = 0; maskNumber < 8; maskNumber++) {
    const { modules, reserved } = blank(version);
    placeData(modules, reserved, codewords, maskNumber); placeFormat(modules, maskNumber); placeVersion(modules, version);
    const candidate = { version, size: modules.length, modules: modules.map(row => row.map(Boolean)), mask: maskNumber, score: penalty(modules.map(row => row.map(Boolean))) };
    if (!best || candidate.score < best.score) best = candidate;
  }
  return { version: best.version, size: best.size, modules: best.modules, mask: best.mask };
}

// An inline SVG of the code with a four-module quiet zone; `title` is its text alternative.
export function qrSvg(text, { title = 'QR code', scale = 4 } = {}) {
  const { size, modules } = encode(text), quiet = 4, full = size + quiet * 2;
  const path = modules.map((row, r) => {   // one rectangle per run of dark modules in a row
    let out = '', c = 0;
    while (c < size) { if (!row[c]) { c += 1; continue; } let end = c; while (end < size && row[end]) end += 1; out += `M${c + quiet} ${r + quiet}h${end - c}v1h-${end - c}z`; c = end; }
    return out;
  }).join('');
  const label = String(title).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="${full * scale}" height="${full * scale}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export const _internals = { BLOCKS, ALIGNMENT, bchFormat, bchVersion, MASKS, dataCapacity, blank };
