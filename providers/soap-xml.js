// Finding elements in the SOAP replies of VMware endpoints (ESXi, vCenter), in time linear in the size of the reply.
//
// The providers used regular expressions of the shape  <(?:\w+:)?NAME(?:\s[^>]*)?>[\s\S]*?</(?:\w+:)?NAME>  for this. When the closing tag is missing, such a
// pattern is tried again from every opening tag and rescans the rest of the reply each time, so the work grows with the square of the reply: a 180 KB reply
// of unclosed tags cost 0.3 s, and a few megabytes would stop the API's single thread for minutes. This is the same language, scanned once:
//
//   - an opening tag is  '<'  [prefix:]NAME  followed by '>' or by whitespace and anything up to the first '>'
//     a closing tag is  '</'  [prefix:]NAME  '>'            (names compare case-insensitively, as the old patterns did with the i flag)
//   - an element is the first opening tag and the first closing tag after it (the lazy match); when there is no closing tag after an opening tag there is
//     none after any later one either, so the search ends there instead of starting over
//   - the position of the '>' that ends a tag is looked up with a pointer that only moves forward, and every test of a tag looks at its first few
//     characters only, so no step depends on how long the rest of the reply is
//
// The results are the strings the old patterns returned (providers/test/soap-xml.test.js compares them on thousands of generated and hostile replies), so the
// callers did not have to change how they use them.

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const cache = new Map();

function heads(name) {
  if (!NAME.test(String(name))) throw new TypeError(`not an element name: ${String(name).slice(0, 40)}`);
  let entry = cache.get(name);
  if (!entry) {
    const escaped = name.replace(/\./g, '\\.');
    entry = {
      // eslint-disable-next-line security/detect-non-literal-regexp -- the element name was checked against NAME above, and its only special character, '.', is escaped
      open: new RegExp(`<(?:\\w+:)?${escaped}(?=[\\s>])`, 'iy'),     // '<', optional prefix, the name, and then '>' or whitespace
      // eslint-disable-next-line security/detect-non-literal-regexp -- the element name was checked against NAME above, and its only special character, '.', is escaped
      close: new RegExp(`</(?:\\w+:)?${escaped}>`, 'iy')
    };
    cache.set(name, entry);
  }
  return entry;
}

// A scan over one reply: the text and the forward-only search for the '>' that ends a tag.
function scan(xml) {
  const text = String(xml);
  let gt = -2;   // -2: not looked up yet, -1: there is none after the last position asked about
  return {
    text,
    gtAfter(position) {
      if (gt === -1) return -1;
      if (gt >= position) return gt;
      gt = text.indexOf('>', position);
      return gt;
    }
  };
}

// The next opening tag at or after `from` for any of the head patterns: { start, end } (end is the index after its '>') or null.
function nextOpening(s, from, openHeads) {
  let lt = from;
  for (;;) {
    lt = s.text.indexOf('<', lt);
    if (lt === -1) return null;
    for (const head of openHeads) {
      head.lastIndex = lt;
      const match = head.exec(s.text);
      if (!match) continue;
      const after = lt + match[0].length;
      const end = s.text[after] === '>' ? after : s.gtAfter(after);
      if (end === -1) return null;        // no '>' anywhere after this: no later tag can end either
      return { start: lt, end: end + 1 };
    }
    lt += 1;
  }
}

// The index of the next closing tag at or after `from`: { start, end } or null.
function nextClosing(s, from, closeHead) {
  let lt = from;
  for (;;) {
    lt = s.text.indexOf('<', lt);
    if (lt === -1) return null;
    closeHead.lastIndex = lt;
    const match = closeHead.exec(s.text);
    if (match) return { start: lt, end: lt + match[0].length };
    lt += 1;
  }
}

// Every tag named `name`, opening or closing, with attributes either way: the old global pattern  <\/?(?:\w+:)?NAME(?:\s[^>]*)?>  as { index, end, text }.
const tokenHeads = new Map();
export function tagTokens(xml, name) {
  heads(name);
  let head = tokenHeads.get(name);
  // eslint-disable-next-line security/detect-non-literal-regexp -- the name went through heads(), which checks it against NAME and escapes '.'
  if (!head) { head = new RegExp(`</?(?:\\w+:)?${name.replace(/\./g, '\\.')}(?=[\\s>])`, 'iy'); tokenHeads.set(name, head); }
  const s = scan(xml), result = [];
  let from = 0;
  for (;;) {
    const lt = s.text.indexOf('<', from);
    if (lt === -1) return result;
    head.lastIndex = lt;
    const match = head.exec(s.text);
    if (!match) { from = lt + 1; continue; }
    const after = lt + match[0].length;
    const end = s.text[after] === '>' ? after : s.gtAfter(after);
    if (end === -1) return result;
    result.push({ index: lt, end: end + 1, text: s.text.slice(lt, end + 1) });
    from = end + 1;
  }
}

function elementAt(s, name, from) {
  const { open, close } = heads(name);
  const opening = nextOpening(s, from, [open]);
  if (!opening) return null;
  const closing = nextClosing(s, opening.end, close);
  if (!closing) return null;
  return { whole: s.text.slice(opening.start, closing.end), inner: s.text.slice(opening.end, closing.start), start: opening.start, end: closing.end };
}

// The first element called `name`: { whole, inner, start, end } or null.
export const firstElement = (xml, name, from = 0) => elementAt(scan(xml), name, from);

// Every element called `name`, whole, in order, each searched for after the end of the previous one.
export function allElements(xml, name) {
  const s = scan(xml), result = [];
  let from = 0;
  for (;;) {
    const element = elementAt(s, name, from);
    if (!element) return result;
    result.push(element.whole);
    from = element.end;
  }
}

export const elementInner = (xml, name) => firstElement(xml, name)?.inner ?? null;

// <NAME ...>text</NAME> where the text is non-empty and holds no '<' (the old `ref` pattern), tried from each opening tag in turn.
export function scalarText(xml, name) {
  const s = scan(xml), { open, close } = heads(name);
  let from = 0;
  for (;;) {
    const opening = nextOpening(s, from, [open]);
    if (!opening) return null;
    const stop = s.text.indexOf('<', opening.end);
    if (stop > opening.end) {
      close.lastIndex = stop;
      if (close.exec(s.text)) return s.text.slice(opening.end, stop);
    }
    from = opening.start + 1;
  }
}

// Every `<NAME ...>text<` for any of `names`, as the old global pattern returned them (the match includes the '<' that ends the text).
export function valueMatches(xml, names) {
  const s = scan(xml), openHeads = names.map(name => heads(name).open), result = [];
  let from = 0;
  for (;;) {
    const opening = nextOpening(s, from, openHeads);
    if (!opening) return result;
    const stop = s.text.indexOf('<', opening.end);
    if (stop > opening.end) { result.push(s.text.slice(opening.start, stop + 1)); from = stop + 1; } else from = opening.start + 1;
  }
}

// value.replace(/<[^>]+>/g, ''): remove tags in one pass. A '<' with no '>' after it stays, and so does '<>' (a tag has at least one character inside).
export function stripTags(value) {
  const text = String(value);
  let output = '', from = 0, lt = text.indexOf('<');
  while (lt !== -1) {
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) { lt = text.indexOf('<', lt + 1); continue; }
    output += text.slice(from, lt);
    from = gt + 1;
    lt = text.indexOf('<', from);
  }
  return output + text.slice(from);
}
