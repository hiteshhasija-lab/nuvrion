# Webhooks: sending alerts out of Nuvrion

A **webhook** is an address Nuvrion posts a short message to when something needs attention: a threshold alert is raised or resolved, a connection has a problem or recovers, or a scheduled run
fails, partly fails or is missed. Point one at a chat channel (Slack, Mattermost, Microsoft Teams, Google Chat, Discord) or at your own system, and the people who need to know are told
without having the console open. Webhooks are on the **Alert rules** page, in the **Webhooks** section.

## Adding one

| | |
|---|---|
| **Name** | Unique whatever the case; at most 20 webhooks. |
| **Address** | Where to post. **https only** (see below). Usually it carries a secret token in the path: it is stored **encrypted** with the platform's key ring, **never shown again** (the page shows only `https://host/…`) and left out of the audit history. |
| **Message format** | *Text message* (`{"text": "[CRITICAL] datastore2 — … (alert raised)"}`: Slack, Mattermost, Teams workflows, Google Chat), *Discord* (`{"content": …}`) or *JSON* (every field, for your own receiver). |
| **Send me** | Which events: alert raised, alert resolved, connection problem, connection recovered, schedule problem. And the lowest severity: *warning or critical*, or *critical only*. |
| **Signing secret** (optional) | Lets the receiver check a message came from your Nuvrion (below). Write-only too. |

**Send test** posts a test message at once and shows the answer; it is kept in the **History** and never tried again.

A webhook only sends what happens **after it was added or turned on**: adding one does not replay yesterday's alerts, and turning one back on does not send what happened while it was off.

## What is sent

The same events as the notification bell (threshold alerts, connection problems and recoveries) plus schedule runs that did not go well. One message per event and webhook: an event is queued once and
never again, even across a restart of Nuvrion.

The JSON format:

```json
{ "id": "…:fired", "deliveryId": "…", "type": "alert.fired", "occurredAt": "2026-10-22T10:00:00.000Z",
  "severity": "critical", "title": "datastore2", "detail": "Full datastores: 90.2%", "text": "[CRITICAL] datastore2 — … (alert raised)",
  "source": "nuvrion", "version": "0.1.198" }
```

Every post has the headers `X-Nuvrion-Event` (the type, or `test`) and `X-Nuvrion-Delivery` (the same `deliveryId`, to recognise a repeat).

### Checking the signature

With a signing secret, each post also carries `X-Nuvrion-Timestamp` (seconds) and `X-Nuvrion-Signature: sha256=<hex>`, the HMAC-SHA256 of `"<timestamp>.<body>"` keyed with the secret. A receiver
should recompute it over the raw body and refuse a message whose timestamp is more than a few minutes old.

## If the receiver is down

A post counts as delivered on any **2xx** answer. A **429**, **408**, **5xx** answer, a timeout or a network failure is **tried again** after 1, 5, 15 and 60 minutes and 3 hours (six attempts in all),
then given up on. Any other answer (a redirect, 400, 401, 403, 404) will not change by waiting and is final at once. Redirects are **never followed**: use the final address. Waiting events do not hold
back newer ones. Each webhook shows when it last succeeded, how many attempts failed in a row and the last error; **History** lists the latest 200 messages (kept 30 days) with the answer to each.

## What a webhook may point at

Because Nuvrion makes the request, an address is a way to make the platform talk to something. So:

- **https only**, no user name or password in the address (put a token in the path, or use the signing secret). Plain `http://` is accepted only if the installation sets `NUVRION_WEBHOOK_ALLOW_HTTP=true`.
- **Not this machine**, and not link-local (such as the cloud metadata address `169.254.169.254`), unspecified, multicast or reserved addresses. This is checked when the webhook is saved **and again
  when the name is resolved at the moment of sending**, and the connection is made to the address that was checked, so a name that pointed somewhere harmless when saved cannot be moved to this machine later.
- Addresses on **private networks** (10.x, 172.16–31.x, 192.168.x) are allowed, because an internal chat server is a normal destination; set `NUVRION_WEBHOOK_BLOCK_PRIVATE=true` to refuse them.
- Certificates are checked as usual. For a receiver with an internal certificate authority, give Nuvrion's container `NODE_EXTRA_CA_CERTS`.
- The wait for an answer is 10 seconds and only the start of the answer is read.

## Who may do what

Everything about webhooks (seeing them, adding, changing, testing, deleting, reading their history) needs `alert.manage`, because where alerts go is part of alerting; there is no new permission. Adding,
changing, deleting and testing are in the audit history (`webhook.created`, `webhook.updated`, `webhook.deleted`, `webhook.tested`) with the name, where it goes (scheme and host), the events and the
severity, whether the address or secret changed, and never the address or secret.

## In the API

```
GET    /api/v1/webhooks                      { items: [{ id, name, format, events, minSeverity, enabled, activeSince, urlHint, hasSigningSecret, consecutiveFailures, lastError, pendingCount, ... }], events, formats }
POST   /api/v1/webhooks                      { name, url, format?, events?, minSeverity?, signingSecret?, enabled? }
PATCH  /api/v1/webhooks/{id}                 any of the fields; the address and secret are kept unless given ("" removes the secret); needs If-Match: "<rowVersion>"
DELETE /api/v1/webhooks/{id}                 its history goes with it
POST   /api/v1/webhooks/{id}/test            send a test message now; returns the delivery
GET    /api/v1/webhook-deliveries?destinationId=&limit=
```

All need `alert.manage`. Errors: `NUV_WEBHOOK_INVALID` (422), `NUV_WEBHOOK_EXISTS`, `NUV_WEBHOOK_LIMIT` (409), `NUV_VERSION_CONFLICT` (412), `NUV_WEBHOOK_NOT_FOUND` (404).

## How it is kept

Webhooks and their deliveries are in `monitoring.webhook_destinations` and `monitoring.webhook_deliveries` (migration 0041). The address and secret are sealed with AES-256-GCM using the key ring that
protects provider credentials (the webhook's id is part of what is authenticated, so a sealed address cannot be moved to another webhook); backups of the configuration already contain the keys. Every
15 seconds (`NUVRION_WEBHOOK_INTERVAL_MS`) Nuvrion queues the events of the last day that each webhook wants and posts what is due, at most 20 a round, claiming each so that two Nuvrion processes cannot
send the same message. Environment: `NUVRION_WEBHOOK_ALLOW_HTTP`, `NUVRION_WEBHOOK_BLOCK_PRIVATE`.

**Not yet**: e-mail (needs an SMTP server and stored mail credentials), per-rule routing (all alert rules go to every webhook that wants alerts of that severity), quiet hours, grouping a flood of alerts
into one message, and acknowledging an alert from the chat channel.
