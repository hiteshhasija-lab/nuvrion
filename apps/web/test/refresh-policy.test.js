import test from 'node:test';
import assert from 'node:assert/strict';
import { HEAVY_EVERY_MS, HEAVY_ON_OPEN_MS, changeSignature, heavyDue, staleOnOpen } from '../refresh-policy.js';

const task = (id, status, extra = {}) => ({ id, status, ...extra });
const connection = (id, extra = {}) => ({ id, status: 'enabled', healthState: 'healthy', lastErrorCode: null, lastSuccessAt: '2026-11-28T00:00:00Z', ...extra });
const NOW = 1_000_000;
const due = over => heavyDue({ background: true, fetchedAt: NOW - 5000, fetchedSignature: 'same', signature: 'same', now: NOW, ...over });

test('every load that is not the timer fetches everything', () => {
  assert.equal(due({ background: false }), true);
});

test('the timer fetches the first time, then only when half a minute has passed', () => {
  assert.equal(due({ fetchedAt: null }), true);
  assert.equal(due({ fetchedAt: undefined }), true);
  assert.equal(due({}), false);
  assert.equal(due({ fetchedAt: NOW - HEAVY_EVERY_MS + 1 }), false);
  assert.equal(due({ fetchedAt: NOW - HEAVY_EVERY_MS }), true);
});

test('the half minute stays well inside the two minutes after which the console calls a reading stale', () => {
  assert.ok(HEAVY_EVERY_MS + 5000 < 120_000 / 2);
});

test('the timer fetches at once when something that changes how machines look has happened', () => {
  assert.equal(due({ signature: 'different' }), true);
});

test('a task that appears, changes state or goes is a change', () => {
  const before = changeSignature({ tasks: [task('a', 'running')] });
  assert.notEqual(changeSignature({ tasks: [task('a', 'completed')] }), before);
  assert.notEqual(changeSignature({ tasks: [task('a', 'running'), task('b', 'queued')] }), before);
  assert.notEqual(changeSignature({ tasks: [] }), before);
});

test('a connection that changes health, error or status, or appears, is a change', () => {
  const before = changeSignature({ connections: [connection('c')] });
  for (const extra of [{ healthState: 'critical' }, { lastErrorCode: 'NUV_ESXI_UNREACHABLE' }, { status: 'disabled' }]) {
    assert.notEqual(changeSignature({ connections: [connection('c', extra)] }), before, JSON.stringify(extra));
  }
  assert.notEqual(changeSignature({ connections: [connection('c'), connection('d')] }), before);
});

test('what changes every few seconds while all is well is not a change, and neither is the order things arrive in', () => {
  const one = changeSignature({ tasks: [task('a', 'completed', { progress: 1 }), task('b', 'queued')], connections: [connection('c'), connection('d')] });
  const two = changeSignature({ tasks: [task('b', 'queued'), task('a', 'completed', { progress: 2, updatedAt: 'later' })], connections: [connection('d', { lastSuccessAt: '2026-11-28T00:05:00Z' }), connection('c', { lastSyncAt: 'later' })] });
  assert.equal(one, two);
  assert.equal(changeSignature(), '');
});

test('opening a page fetches afresh only when what is shown is more than a few seconds old', () => {
  assert.equal(staleOnOpen(null, NOW), false, 'the sign-in load is already on its way');
  assert.equal(staleOnOpen(NOW - 1000, NOW), false);
  assert.equal(staleOnOpen(NOW - HEAVY_ON_OPEN_MS, NOW), true);
});
