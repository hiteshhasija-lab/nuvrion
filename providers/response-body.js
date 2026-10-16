// Reading the body of a reply from a managed endpoint (an ESXi host, a vCenter, a datastore browser) without letting the endpoint decide how much memory that takes.
//
// `await response.text()` reads whatever arrives until the request timeout; a few hundred megabytes of XML fits in that time on a LAN and would be held in
// memory as a string, and again as the parsed pieces. A real reply is far smaller: the largest observed inventory reply is a few megabytes. The limit is far above
// that and far below what would hurt, and a reply that exceeds it is refused rather than truncated (a truncated XML document would parse as "missing" data and
// the inventory would then mark real machines as gone).

export const MAX_REPLY_BYTES = 64 * 1024 * 1024;
export const REPLY_TOO_LARGE = 'NUV_PROVIDER_RESPONSE_TOO_LARGE';

export class ReplyTooLargeError extends Error {
  constructor(limitBytes, receivedBytes = null) {
    super(`The endpoint's reply is larger than the ${Math.round(limitBytes / 1024 / 1024)} MB Nuvrion accepts${receivedBytes ? ` (at least ${receivedBytes} bytes)` : ''}.`);
    this.code = REPLY_TOO_LARGE;
    this.retryable = false;
  }
}

// The text of the reply, or ReplyTooLargeError. `make` turns that into the calling provider's own error type; without it the ReplyTooLargeError is thrown.
export async function readBoundedText(response, { limitBytes = MAX_REPLY_BYTES, make = error => error } = {}) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw make(new ReplyTooLargeError(limitBytes, declared));
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    // a stand-in response with only text(): nothing to stream, so check the size after the fact
    const text = await response.text();
    if (Buffer.byteLength(text) > limitBytes) throw make(new ReplyTooLargeError(limitBytes));
    return text;
  }
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel().catch(() => {});
      throw make(new ReplyTooLargeError(limitBytes, received));
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));   // UTF-8, byte order mark dropped: what response.text() does
}
