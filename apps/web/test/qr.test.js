import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, qrSvg, reedSolomon, chooseVersion, MAX_VERSION, _internals } from '../qr.js';

// The QR encoder is checked by reading its output back the way a scanner would: format information, version information, the codewords in reading order, the error
// correction of every block, and the text. (It was also decoded by an independent scanner library, jsQR, for every version it can produce.)
const { BLOCKS, bchFormat, bchVersion, MASKS, blank } = _internals;

test('the error correction matches the published example, and the format and version information match the standard tables', () => {
  assert.deepEqual(reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23], '"HELLO WORLD", version 1, level M');
  assert.equal(bchFormat(0).toString(2).padStart(15, '0'), '101010000010010');
  assert.equal(bchFormat(1).toString(2).padStart(15, '0'), '101000100100101');
  assert.equal(bchVersion(7).toString(2).padStart(18, '0'), '000111110010010100');
  assert.equal(bchVersion(10).toString(2).padStart(18, '0'), '001010010011010011');
});

function read({ version, size, modules }) {
  const { reserved } = blank(version), bit = (r, c) => (modules[r][c] ? 1 : 0);
  // format information: two copies that must agree, and be a valid code word for level M
  const first = [], second = [];
  for (let i = 0; i < 6; i++) first.push(bit(i, 8)); first.push(bit(7, 8), bit(8, 8), bit(8, 7)); for (let i = 9; i < 15; i++) first.push(bit(8, 14 - i));
  for (let i = 0; i < 8; i++) second.push(bit(8, size - 1 - i)); for (let i = 8; i < 15; i++) second.push(bit(size - 15 + i, 8));
  const info = bits => bits.reduce((value, b, i) => value | (b << i), 0);
  assert.equal(info(first), info(second), 'both copies of the format information agree');
  const mask = [...Array(8).keys()].find(m => bchFormat(m) === info(first));
  assert.notEqual(mask, undefined, 'the format information is a valid code word for level M');
  if (version >= 7) {   // version information: two copies
    const a = [], b = [];
    for (let i = 0; i < 18; i++) { a.push(bit(Math.floor(i / 3), (i % 3) + size - 11)); b.push(bit((i % 3) + size - 11, Math.floor(i / 3))); }
    assert.equal(info(a), bchVersion(version)); assert.equal(info(b), bchVersion(version));
  }
  // codewords in reading order, unmasked
  const bits = []; let upward = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [column, column - 1]) if (!reserved[row][c]) bits.push(bit(row, c) ^ (MASKS[mask](row, c) ? 1 : 0));
    }
    upward = !upward;
  }
  const words = []; for (let i = 0; i + 8 <= bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  assert.equal(words.length * 8 + (bits.length % 8), bits.length);
  // de-interleave and check every block's error correction
  const [ecPerBlock, groups] = BLOCKS[version], sizes = groups.flatMap(([count, length]) => Array(count).fill(length)), blocks = sizes.map(() => ({ data: [], ec: [] }));
  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) blocks.forEach((block, k) => { if (i < sizes[k]) block.data.push(words[at++]); });
  for (let i = 0; i < ecPerBlock; i++) blocks.forEach(block => block.ec.push(words[at++]));
  for (const block of blocks) assert.deepEqual(reedSolomon(block.data, ecPerBlock), block.ec, 'the error correction codewords of every block are right');
  const data = blocks.flatMap(block => block.data), stream = data.flatMap(word => [...word.toString(2).padStart(8, '0')].map(Number));
  const take = (from, length) => parseInt(stream.slice(from, from + length).join(''), 2), countLength = version < 10 ? 8 : 16;
  assert.equal(take(0, 4), 0b0100, 'byte mode');
  const length = take(4, countLength), payload = Buffer.from(Array.from({ length }, (_, i) => take(4 + countLength + 8 * i, 8)));
  return payload.toString('utf8');
}

test('what the encoder writes reads back as the same text, for every length up to the largest version', () => {
  const uri = 'otpauth://totp/Nuvrion:ann%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Nuvrion&algorithm=SHA1&digits=6&period=30';
  const texts = [uri, 'Zürich 東京 ✓', 'a', ...[14, 15, 26, 27, 42, 53, 78, 106, 122, 154, 195, 213].map(n => 'k'.repeat(n))];
  const versions = new Set();
  for (const text of texts) { const code = encode(text); versions.add(code.version); assert.equal(read(code), text, `${text.length} characters, version ${code.version}`); }
  assert.deepEqual([...versions].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter(v => versions.has(v)));
  assert.ok(versions.size >= 8, 'a spread of versions was exercised, including those with version information (7 and up)');
});

test('the fixed patterns are where a scanner looks for them', () => {
  const { size, modules } = encode('hello');
  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
      assert.equal(modules[r + i][c + j], ring !== 2, `finder pattern at ${r},${c} (${i},${j})`);
    }
  }
  for (let i = 8; i < size - 8; i++) { assert.equal(modules[6][i], i % 2 === 0, 'horizontal timing'); assert.equal(modules[i][6], i % 2 === 0, 'vertical timing'); }
  assert.equal(modules[size - 8][8], true, 'the dark module');
});

test('the largest text is refused clearly, and the picture is an accessible SVG with the quiet zone', () => {
  assert.equal(chooseVersion(213), MAX_VERSION);
  assert.throws(() => encode('x'.repeat(214)), /NUV_QR_TOO_LONG/);
  const svg = qrSvg('hello', { title: 'Scan <me> & "go"' });
  assert.match(svg, /^<svg [^>]*role="img" aria-label="Scan &lt;me&gt; &amp; &quot;go&quot;"/);
  assert.match(svg, /viewBox="0 0 29 29"/, 'version 1 is 21 modules plus a four-module quiet zone on each side');
  assert.doesNotMatch(svg, /<script|onload|href=/i);
});
