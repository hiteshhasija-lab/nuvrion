import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from '../src/login-rate-limiter.js';

function limiter(options = {}) {
  const time = { now: 1_000_000 };
  return { time, limiter: new LoginRateLimiter({ limit: 3, windowMs: 60_000, clock: () => time.now, ...options }) };
}

test('attempts are allowed until the failure limit is reached, then blocked', () => {
  const { limiter: l } = limiter();
  for (let i = 0; i < 3; i++) { assert.equal(l.check('10.0.0.5', 'admin').allowed, true); l.recordFailure('10.0.0.5', 'admin'); }
  const blocked = l.check('10.0.0.5', 'admin');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
});

test('the block lifts once the window passes, and the retry hint counts down', () => {
  const { limiter: l, time } = limiter();
  for (let i = 0; i < 3; i++) l.recordFailure('c', 'u');
  assert.equal(l.check('c', 'u').retryAfterSeconds, 60);
  time.now += 45_000;
  assert.equal(l.check('c', 'u').retryAfterSeconds, 15);
  time.now += 15_001;
  assert.equal(l.check('c', 'u').allowed, true);
});

test('failures are tracked per client and user, case-insensitively for the user', () => {
  const { limiter: l } = limiter();
  for (let i = 0; i < 3; i++) l.recordFailure('10.0.0.5', 'Admin');
  assert.equal(l.check('10.0.0.5', ' admin ').allowed, false, 'same user, different case/spacing');
  assert.equal(l.check('10.0.0.6', 'admin').allowed, true, 'different client');
  assert.equal(l.check('10.0.0.5', 'operator').allowed, true, 'different user');
});

test('a successful sign-in can reset the counter', () => {
  const { limiter: l } = limiter();
  for (let i = 0; i < 3; i++) l.recordFailure('c', 'u');
  l.reset('c', 'u');
  assert.equal(l.check('c', 'u').allowed, true);
});

test('only failures inside the window count', () => {
  const { limiter: l, time } = limiter();
  l.recordFailure('c', 'u'); l.recordFailure('c', 'u');
  time.now += 61_000;
  l.recordFailure('c', 'u');
  assert.equal(l.check('c', 'u').allowed, true, 'the two old failures have expired');
});

test('defaults are five failures per five minutes', () => {
  const l = new LoginRateLimiter();
  assert.equal(l.limit, 5);
  assert.equal(l.windowMs, 300_000);
});
