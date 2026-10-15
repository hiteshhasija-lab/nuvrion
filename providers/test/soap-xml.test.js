import test from 'node:test';
import assert from 'node:assert/strict';
import { firstElement, allElements, elementInner, scalarText, valueMatches, stripTags, tagTokens } from '../soap-xml.js';

// providers/soap-xml.js replaces regular expressions that went quadratic on a reply with unclosed tags. These tests keep the two in step: the original
// patterns (copied verbatim, below) are run next to the helper on thousands of generated replies, and the helper is timed on the replies that hurt them.

const ref = {
  inner: (xml, name) => String(xml).match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'))?.[1] ?? null,
  whole: (xml, name) => String(xml).match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:\\w+:)?${name}>`, 'i'))?.[0] ?? null,
  all: (xml, name) => String(xml).match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:\\w+:)?${name}>`, 'gi')) ?? [],
  scalar: (xml, name) => String(xml).match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([^<]+)<\\/(?:\\w+:)?${name}>`, 'i'))?.[1] ?? null,
  values: xml => String(xml).match(/<(?:\w+:)?(?:val|nodeWorldWideName|portWorldWideName)(?:\s[^>]*)?>([^<]+)</gi) ?? [],
  strip: value => String(value).replace(/<[^>]+>/g, ''),
  tokens: (xml, name) => { const pattern = new RegExp(`<\\/?(?:\\w+:)?${name}(?:\\s[^>]*)?>`, 'gi'), out = []; let match; while ((match = pattern.exec(String(xml)))) out.push({ index: match.index, end: pattern.lastIndex, text: match[0] }); return out; }
};

// A small deterministic generator (no dependency, repeatable): replies made of the fragments real and broken SOAP is made of.
function generator(seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const pick = list => list[Math.floor(next() * list.length)];
  return { next, pick };
}
const FRAGMENTS = [
  '<propSet>', '</propSet>', '<ns:propSet attr="x">', '</ns:propSet>', '<PROPSET>', '</PropSet>', '<propSetX>', '</propSetX>', '<xpropSet>', '<propSet/>', '<propSet />', '<propSet\t>',
  '<val>', '</val>', '<vim25:val xsi:type="xsd:string">', '</vim25:val>', '<value>', '<name>', '</name>', '<nodeWorldWideName>', '</nodeWorldWideName>', '<portWorldWideName a="b">',
  'text', '12345', ' ', '\n', 'a:b', '<', '>', '<>', '</', '<a<propSet>', '<:propSet>', '<propSet a=">">', '<val  >', '<obj type="VirtualMachine">', '</obj>', '&amp;', '<!-- c -->',
  '<ns:ns2:propSet>', '<propSet attr', '<val ', '<name >', '</ name>', '</name >'
];
const NAMES = ['propSet', 'val', 'name', 'obj'];

test('on thousands of generated replies the helper returns exactly what the original patterns returned', () => {
  for (let seed = 1; seed <= 6000; seed++) {
    const { next, pick } = generator(seed);
    const length = Math.floor(next() * 40);
    let xml = '';
    for (let index = 0; index < length; index++) xml += pick(FRAGMENTS);
    for (const name of NAMES) {
      const where = `seed ${seed} name ${name} xml ${JSON.stringify(xml)}`;
      assert.equal(elementInner(xml, name), ref.inner(xml, name), `inner: ${where}`);
      assert.equal(firstElement(xml, name)?.whole ?? null, ref.whole(xml, name), `whole: ${where}`);
      assert.deepEqual(allElements(xml, name), ref.all(xml, name), `all: ${where}`);
      assert.equal(scalarText(xml, name), ref.scalar(xml, name), `scalar: ${where}`);
    }
    assert.deepEqual(valueMatches(xml, ['val', 'nodeWorldWideName', 'portWorldWideName']), ref.values(xml), `values: seed ${seed} ${JSON.stringify(xml)}`);
    for (const name of NAMES) assert.deepEqual(tagTokens(xml, name), ref.tokens(xml, name), `tokens: seed ${seed} name ${name} ${JSON.stringify(xml)}`);
    assert.equal(stripTags(xml), ref.strip(xml), `strip: seed ${seed} ${JSON.stringify(xml)}`);
  }
});

test('a realistic ESXi property reply gives the same values', () => {
  const xml = `<?xml version="1.0"?><soapenv:Envelope><soapenv:Body><RetrievePropertiesExResponse><returnval><objects><obj type="VirtualMachine">vm-1</obj>
    <propSet><name>name</name><val xsi:type="xsd:string">nuvrion-app-01</val></propSet><propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>
    <propSet><name>config.hardware.device</name><val><VirtualDevice><key>1</key></VirtualDevice><VirtualDevice><key>2</key></VirtualDevice></val></propSet></objects></returnval></RetrievePropertiesExResponse></soapenv:Body></soapenv:Envelope>`;
  for (const name of ['obj', 'objects', 'propSet', 'val', 'name', 'VirtualDevice', 'returnval']) {
    assert.deepEqual(allElements(xml, name), ref.all(xml, name), name);
    assert.equal(elementInner(xml, name), ref.inner(xml, name), name);
    assert.equal(scalarText(xml, name), ref.scalar(xml, name), name);
  }
  assert.equal(scalarText(xml, 'obj'), 'vm-1');
  assert.equal(allElements(xml, 'propSet').length, 3);
});

test('a reply built to make the old patterns quadratic is scanned in a fraction of a second', () => {
  const MB = 1024 * 1024;
  const hostile = {
    'opening tags that never close': '<propSet>'.repeat(Math.floor(1.8 * MB / 9)),
    'opening tags that never end': '<propSet '.repeat(Math.floor(1.8 * MB / 9)),
    'a million angle brackets': '<'.repeat(MB),
    'scalar candidates with no closing tag': '<name>x<b>'.repeat(Math.floor(1.8 * MB / 10)),
    'values with no text': '<val>'.repeat(Math.floor(1.8 * MB / 5)),
    'one stray closing tag first, then openers': `</propSet>${'<propSet>'.repeat(Math.floor(1.8 * MB / 9))}`,
    'many closing tags of another name': `${'<name>'.repeat(50000)}${'</nam>'.repeat(50000)}`
  };
  for (const [label, xml] of Object.entries(hostile)) {
    const started = process.hrtime.bigint();
    allElements(xml, 'propSet'); allElements(xml, 'name'); elementInner(xml, 'propSet'); elementInner(xml, 'name'); scalarText(xml, 'name'); scalarText(xml, 'propSet');
    valueMatches(xml, ['val', 'nodeWorldWideName']); stripTags(xml); tagTokens(xml, 'propSet'); tagTokens(xml, 'name');
    const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(milliseconds < 1500, `${label}: ${milliseconds.toFixed(0)} ms for ${(xml.length / MB).toFixed(1)} MB`);
  }
});

test('a name that is not an element name is refused rather than becoming a pattern', () => {
  for (const bad of ['a b', 'x)|(', '', '1abc', '../x', 'a*']) assert.throws(() => elementInner('<a/>', bad), TypeError, JSON.stringify(bad));
});
