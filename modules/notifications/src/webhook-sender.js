// Posting a message to a webhook (docs/webhooks.md). The request is made with the safety rules of webhook-rules.js applied where it matters: the address is checked again when the name
// is resolved and the connection is made to that checked address (a name that pointed somewhere harmless when the webhook was saved cannot be changed to point at this machine later),
// redirects are never followed, the wait is bounded, and only the start of the answer is read.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { LIMITS, WebhookError, checkAddressAllowed, parseWebhookUrl } from './webhook-rules.js';

const clip = text => String(text ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 200);

// A DNS lookup that refuses what the policy refuses. Used as the `lookup` of the request, so the address that is checked is the address that is connected to.
export function safeLookup(policy, resolve = dns.lookup) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback, wantsAll = typeof options === 'object' && options?.all;
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return done(error);
      try {
        const allowed = addresses.filter(entry => { try { checkAddressAllowed(entry.address, policy); return true; } catch { return false; } });
        if (!allowed.length) throw new WebhookError('That name resolves only to addresses a webhook may not use (this machine, link-local or reserved addresses).');
        return wantsAll ? done(null, allowed) : done(null, allowed[0].address, allowed[0].family);
      } catch (refused) { return done(refused); }
    });
  };
}

// destination: { url } ; body: string ; headers: object. Returns { ok, status?, error?, durationMs }. Never throws.
export async function postWebhook({ url, body, headers, policy = {}, timeoutMs = LIMITS.timeoutMs, resolve = dns.lookup }) {
  const started = Date.now();
  const finish = result => ({ ...result, durationMs: Date.now() - started });
  let target;
  try { target = parseWebhookUrl(url, policy); } catch (error) { return finish({ ok: false, error: clip(error.message) }); }
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise(resolvePromise => {
    let settled = false;
    const settle = result => { if (!settled) { settled = true; resolvePromise(finish(result)); } };
    const request = transport.request({
      protocol: target.protocol, hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || undefined, path: `${target.pathname}${target.search}`, method: 'POST', headers,
      lookup: isIP(target.hostname.replace(/^\[|\]$/g, '')) ? undefined : safeLookup(policy, resolve), timeout: timeoutMs, agent: false
    }, response => {
      let read = 0, text = '';
      response.on('data', chunk => { read += chunk.length; if (text.length < 200) text += chunk.toString('utf8', 0, 200); if (read > 4096) response.destroy(); });
      const complete = () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) return settle({ ok: true, status });
        if (status >= 300 && status < 400) return settle({ ok: false, status, error: `The receiver answered with a redirect (HTTP ${status}); redirects are not followed. Use the final address.` });
        return settle({ ok: false, status, error: clip(`HTTP ${status}${text.trim() ? `: ${text.trim()}` : ''}`) });
      };
      response.on('end', complete); response.on('close', complete); response.on('error', complete);
    });
    request.on('timeout', () => { request.destroy(new Error(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`)); });
    request.on('error', error => settle({ ok: false, error: clip(error.code === 'ENOTFOUND' ? `The name ${target.hostname} could not be found.` : error.code === 'ECONNREFUSED' ? 'The receiver refused the connection.' : error.message || error.code) }));
    request.end(body);
  });
}
