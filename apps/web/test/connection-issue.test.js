import test from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, retryText, connectionIssueHtml } from '../connection-issue.js';

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const when = iso => `<${iso}>`;
const NOW = Date.parse('2026-10-06T03:00:00Z');
const failing = over => ({ status: 'enabled', healthState: 'critical', consecutiveFailures: 240, lastErrorCode: 'NUV_ESXI_UNREACHABLE', lastSuccessAt: '2026-10-05T05:51:18Z', nextRetryAt: '2026-10-06T03:01:40Z', ...over });

test('known error codes get plain-English reasons; unknown codes are humanised', () => {
  assert.equal(failureReason('NUV_ESXI_UNREACHABLE'), 'Host unreachable');
  assert.equal(failureReason('NUV_AGENT_OFFLINE'), 'Workstation agent offline');
  assert.equal(failureReason('NUV_SOMETHING_NEW_BROKE'), 'Something new broke');
  assert.equal(failureReason(null), 'Connection failing');
});

test('retry countdown formats seconds, minutes, and "now"', () => {
  assert.equal(retryText('2026-10-06T03:00:45Z', NOW), 'next retry in 45s');
  assert.equal(retryText('2026-10-06T03:01:40Z', NOW), 'next retry in 1m 40s');
  assert.equal(retryText('2026-10-06T03:02:05Z', NOW), 'next retry in 2m 05s');
  assert.equal(retryText('2026-10-06T02:59:00Z', NOW), 'retrying now');
});

test('a critical connection shows reason, last success, failure count and next retry', () => {
  const html = connectionIssueHtml(failing(), { esc, when, now: NOW });
  assert.match(html, /<strong>Host unreachable<\/strong>/);
  assert.match(html, /Last successful sync <2026-10-05T05:51:18Z>/);
  assert.match(html, /240 failed attempts/);
  assert.match(html, /data-retry-at="2026-10-06T03:01:40Z">next retry in 1m 40s</);
});

test('healthy, unknown and deleted connections show nothing', () => {
  for (const over of [{ healthState: 'healthy' }, { healthState: 'unknown' }, { status: 'deleted' }]) {
    assert.equal(connectionIssueHtml(failing(over), { esc, when, now: NOW }), '');
  }
});

test('singular failure, never-synced and no-retry-scheduled cases read correctly', () => {
  const html = connectionIssueHtml(failing({ consecutiveFailures: 1, lastSuccessAt: null, nextRetryAt: null }), { esc, when, now: NOW });
  assert.match(html, /Never synced successfully/);
  assert.match(html, /1 failed attempt(?!s)/);
  assert.doesNotMatch(html, /next retry|retrying/);
});

test('server-supplied values are escaped', () => {
  const html = connectionIssueHtml(failing({ lastErrorCode: '<img src=x onerror=alert(1)>', nextRetryAt: '"><script>' }), { esc, when, now: NOW });
  assert.doesNotMatch(html, /<img|<script/);
});
