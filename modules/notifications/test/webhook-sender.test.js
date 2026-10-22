import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postWebhook, safeLookup } from '../src/webhook-sender.js';

// Posting a webhook against a local receiver: what counts as delivered, what is reported when the receiver is slow, refuses, redirects or fails, and that the platform will not be pointed
// at itself through a name.
const policy = { allowHttp: true, allowLoopback: true };
const received = [];
let behaviour = () => ({ status: 200 });
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    const answer = behaviour(req);
    if (answer.hang) return;
    res.writeHead(answer.status, answer.headers ?? {}); res.end(answer.body ?? '');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); });
const headers = body => ({ 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-nuvrion-event': 'test' });

test('a 2xx answer is delivered; the receiver gets the body and headers as sent', async () => {
  received.length = 0; behaviour = () => ({ status: 204 });
  const body = JSON.stringify({ hello: 'world' });
  const result = await postWebhook({ url: `${base}/hook?token=abc`, body, headers: headers(body), policy });
  assert.deepEqual([result.ok, result.status], [true, 204]); assert.ok(result.durationMs >= 0);
  assert.deepEqual([received[0].method, received[0].url, received[0].body, received[0].headers['x-nuvrion-event']], ['POST', '/hook?token=abc', body, 'test']);
});

test('an error answer is reported with its status and the start of what the receiver said; a redirect is refused, not followed', async () => {
  behaviour = () => ({ status: 500, body: 'boom\nline two' });
  const failed = await postWebhook({ url: `${base}/x`, body: '{}', headers: headers('{}'), policy });
  assert.deepEqual([failed.ok, failed.status, failed.error], [false, 500, 'HTTP 500: boom line two']);
  received.length = 0; behaviour = req => (req.url === '/final' ? { status: 200 } : { status: 302, headers: { location: `${base}/final` } });
  const redirected = await postWebhook({ url: `${base}/start`, body: '{}', headers: headers('{}'), policy });
  assert.deepEqual([redirected.ok, redirected.status], [false, 302]); assert.match(redirected.error, /redirect.*not followed/);
  assert.deepEqual(received.map(request => request.url), ['/start'], 'the redirect target was never asked');
  behaviour = () => ({ status: 429, body: 'x'.repeat(10_000) });
  const long = await postWebhook({ url: `${base}/x`, body: '{}', headers: headers('{}'), policy });
  assert.equal(long.status, 429); assert.ok(long.error.length <= 200, 'only the start of the answer is kept');
});

test('a receiver that does not answer in time, or refuses the connection, is reported plainly', async () => {
  behaviour = () => ({ hang: true });
  const slow = await postWebhook({ url: `${base}/x`, body: '{}', headers: headers('{}'), policy, timeoutMs: 300 });
  assert.equal(slow.ok, false); assert.equal(slow.status, undefined); assert.match(slow.error, /No answer within/);
  const closed = http.createServer(); await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve)); const port = closed.address().port; await new Promise(resolve => closed.close(resolve));
  const refused = await postWebhook({ url: `http://127.0.0.1:${port}/x`, body: '{}', headers: headers('{}'), policy });
  assert.deepEqual([refused.ok, refused.error], [false, 'The receiver refused the connection.']);
});

test('the platform cannot be pointed at itself: not by address, not by a name that resolves to it, and not over http unless the installation allows it', async () => {
  received.length = 0; behaviour = () => ({ status: 200 });
  const byAddress = await postWebhook({ url: `${base}/x`, body: '{}', headers: headers('{}'), policy: { allowHttp: true } });
  assert.equal(byAddress.ok, false); assert.match(byAddress.error, /this machine/);
  const overHttp = await postWebhook({ url: `${base}/x`, body: '{}', headers: headers('{}'), policy: { allowLoopback: true } });
  assert.match(overHttp.error, /https/);
  const toLoopback = (hostname, options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
  const byName = await postWebhook({ url: `http://innocent.example.test:${server.address().port}/x`, body: '{}', headers: headers('{}'), policy: { allowHttp: true }, resolve: toLoopback });
  assert.equal(byName.ok, false); assert.match(byName.error, /resolves only to addresses a webhook may not use/);
  const toMetadata = (hostname, options, callback) => callback(null, [{ address: '169.254.169.254', family: 4 }]);
  assert.match((await postWebhook({ url: 'http://metadata.example.test/x', body: '{}', headers: headers('{}'), policy: { allowHttp: true, allowLoopback: true }, resolve: toMetadata })).error, /resolves only to addresses/);
  assert.deepEqual(received, [], 'nothing reached the receiver');
  const allowedByName = await postWebhook({ url: `http://friendly.example.test:${server.address().port}/ok`, body: '{}', headers: headers('{}'), policy, resolve: toLoopback });
  assert.equal(allowedByName.ok, true, 'when the installation allows loopback, the checked address is the one connected to'); assert.equal(received.length, 1);
});

test('a name with several addresses is used with the allowed ones only', async () => {
  const mixed = (hostname, options, callback) => callback(null, [{ address: '169.254.169.254', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  const lookup = safeLookup({ allowLoopback: true }, mixed);
  const all = await new Promise((resolve, reject) => lookup('x.example.test', { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))));
  assert.deepEqual(all.map(entry => entry.address), ['127.0.0.1']);
  const single = await new Promise((resolve, reject) => lookup('x.example.test', {}, (error, address, family) => (error ? reject(error) : resolve([address, family]))));
  assert.deepEqual(single, ['127.0.0.1', 4]);
  const failing = safeLookup({}, (hostname, options, callback) => callback(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })));
  await assert.rejects(new Promise((resolve, reject) => failing('gone.example.test', {}, (error) => (error ? reject(error) : resolve()))), /nope/);
  assert.match((await postWebhook({ url: 'http://gone.example.test/x', body: '{}', headers: headers('{}'), policy, resolve: (hostname, options, callback) => callback(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) })).error, /could not be found/);
});

test('an address that is not acceptable is reported without making any request', async () => {
  received.length = 0;
  for (const url of ['ftp://x.example.com', 'https://user:pw@x.example.com/', 'nonsense']) assert.equal((await postWebhook({ url, body: '{}', headers: headers('{}'), policy })).ok, false);
  assert.deepEqual(received, []);
});
