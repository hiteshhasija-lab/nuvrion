import test from 'node:test';
import assert from 'node:assert/strict';
import { forecast, sanitizeReading, worthKeeping, daysUntilFullForAlert, trend, chartPoints, describeForecast, DAY_MS, HORIZON_DAYS } from '../src/capacity-rules.js';

// Capacity forecasts: what a reading must look like to be kept, how a straight line through the last two weeks becomes "full in about N days", when no forecast is given at all, how
// far the forecast is to be trusted, and what an alert rule may be told.
const GB = 1024 ** 3, NOW = Date.parse('2026-10-21T12:00:00Z'), CAPACITY = 1000 * GB;
// n readings, one every `everyHours`, ending now, whose used space grows by `perDay` bytes a day from `startUsed`; `noise(i)` perturbs each reading
const series = ({ n = 49, everyHours = 6, startUsed = 500 * GB, perDay = 10 * GB, capacityBytes = CAPACITY, noise = () => 0 } = {}) =>
  Array.from({ length: n }, (_, i) => { const at = NOW - (n - 1 - i) * everyHours * 3_600_000; return { at, capacityBytes, usedBytes: Math.round(startUsed + perDay * ((at - (NOW - (n - 1) * everyHours * 3_600_000)) / DAY_MS) + noise(i)) }; });

test('a reading is kept only when the numbers can be believed: whole non-negative sizes, free space no larger than the size, a real time', () => {
  assert.deepEqual(sanitizeReading({ capacityBytes: 1000, freeBytes: 250, observedAt: '2026-10-21T10:00:00Z' }), { capacityBytes: 1000, freeBytes: 250, usedBytes: 750, at: Date.parse('2026-10-21T10:00:00Z') });
  assert.equal(sanitizeReading({ capacityBytes: 1000.4, freeBytes: 250.2, observedAt: NOW }).usedBytes, 750);
  for (const bad of [{ capacityBytes: 0, freeBytes: 0 }, { capacityBytes: 1000, freeBytes: 1001 }, { capacityBytes: 1000, freeBytes: -1 }, { capacityBytes: NaN, freeBytes: 1 }, { capacityBytes: '1000', freeBytes: 1 }, { capacityBytes: 1000, freeBytes: 1, observedAt: 'yesterday' }, { capacityBytes: 1000, freeBytes: undefined }]) {
    assert.equal(sanitizeReading({ observedAt: NOW, ...bad }), null, JSON.stringify(bad));
  }
});

test('a reading near one already kept is skipped, unless the size changed; one a full interval away is kept', () => {
  const half = 30 * 60_000, kept = [{ at: NOW, capacityBytes: 1000, usedBytes: 100 }];
  const reading = (offset, capacityBytes = 1000) => ({ at: NOW + offset, capacityBytes, usedBytes: 100, freeBytes: capacityBytes - 100 });
  assert.equal(worthKeeping(reading(10 * 60_000), kept, half), false);
  assert.equal(worthKeeping(reading(-10 * 60_000), kept, half), false, 'before as well as after');
  assert.equal(worthKeeping(reading(half), kept, half), true);
  assert.equal(worthKeeping(reading(10 * 60_000, 2000), kept, half), true, 'a datastore that was extended is recorded at once');
  assert.equal(worthKeeping(reading(0, 2000), kept, half), false, 'but not twice for the same moment');
  assert.equal(worthKeeping(reading(0), [], half), true);
});

test('a datastore growing 10 GB a day with 380 GB free will be full in about 38 days, and the date follows', () => {
  const f = forecast(series(), { now: NOW });
  assert.equal(f.status, 'growing'); assert.equal(f.confidence, 'high');
  assert.ok(Math.abs(f.growthBytesPerDay / GB - 10) < 0.01, String(f.growthBytesPerDay / GB));
  assert.ok(Math.abs(f.daysUntilFull - 38) < 0.2, String(f.daysUntilFull));
  assert.ok(Math.abs(Date.parse(f.projectedFullAt) - (NOW + 38 * DAY_MS)) < 0.5 * DAY_MS);
  assert.deepEqual([f.sampleCount, f.spanDays, f.usedBytes, f.capacityBytes], [49, 12, 500 * GB + 120 * GB, CAPACITY]);
  assert.equal(f.freeBytes, CAPACITY - f.usedBytes);
});

test('too little history gives no forecast: fewer than six readings, or less than a day', () => {
  assert.equal(forecast(series({ n: 5 }), { now: NOW }).status, 'insufficient');
  const short = forecast(series({ n: 12, everyHours: 1 }), { now: NOW });
  assert.equal(short.status, 'insufficient'); assert.equal(short.daysUntilFull, null); assert.equal(short.confidence, null);
  assert.equal(short.usedBytes > 0, true, 'it still says how full the datastore is');
  assert.equal(forecast([], { now: NOW }).status, 'insufficient'); assert.equal(forecast([], { now: NOW }).usedBytes, null);
  assert.equal(forecast(series({ n: 7, everyHours: 4 }), { now: NOW }).status, 'growing', 'seven readings over a day and a half are enough');
});

test('a flat or barely moving datastore is stable, a emptying one is shrinking, and neither has a date', () => {
  const flat = forecast(series({ perDay: 0 }), { now: NOW });
  assert.deepEqual([flat.status, flat.daysUntilFull, flat.projectedFullAt, flat.confidence], ['stable', null, null, 'high']);
  const slow = forecast(series({ perDay: 0.1 * GB }), { now: NOW });   // 3 GB in 30 days, 0.3% of the size
  assert.equal(slow.status, 'stable');
  const emptying = forecast(series({ perDay: -20 * GB }), { now: NOW });
  assert.deepEqual([emptying.status, emptying.daysUntilFull], ['shrinking', null]); assert.ok(emptying.growthBytesPerDay < 0);
});

test('a full datastore is full whatever the history', () => {
  const full = series({ n: 3, startUsed: CAPACITY });
  const f = forecast(full, { now: NOW });
  assert.deepEqual([f.status, f.daysUntilFull, f.confidence], ['full', 0, 'high']);
  assert.equal(describeForecast(f), 'Full');
});

test('only the readings since the datastore last changed size are used, so extending a datastore does not look like a drop', () => {
  const before = series({ n: 20, everyHours: 6, startUsed: 900 * GB, perDay: 10 * GB, capacityBytes: 1000 * GB });
  const after = series({ n: 30, everyHours: 6, startUsed: 700 * GB, perDay: 10 * GB, capacityBytes: 2000 * GB }).map(sample => ({ ...sample, at: sample.at }));
  const gap = before.at(-1).at; const merged = [...before.map(s => ({ ...s, at: s.at - 10 * DAY_MS })), ...after];
  assert.ok(gap > 0);
  const f = forecast(merged, { now: NOW });
  assert.equal(f.capacityBytes, 2000 * GB); assert.equal(f.sampleCount, 30, 'the 20 readings of the old size are left out'); assert.equal(f.status, 'growing');
  assert.ok(Math.abs(f.growthBytesPerDay / GB - 10) < 0.01);
});

test('readings older than the window are not used, and readings after now are ignored', () => {
  const old = series({ n: 30, everyHours: 24 }).map(sample => ({ ...sample, at: sample.at - 40 * DAY_MS }));
  assert.equal(forecast(old, { now: NOW }).status, 'insufficient');
  const future = [...series(), { at: NOW + DAY_MS, capacityBytes: CAPACITY, usedBytes: CAPACITY }];
  assert.equal(forecast(future, { now: NOW }).status, 'growing');
});

test('confidence follows the length of the history and how closely the readings follow the line', () => {
  assert.equal(forecast(series({ n: 49, everyHours: 6 }), { now: NOW }).confidence, 'high');
  assert.equal(forecast(series({ n: 17, everyHours: 6 }), { now: NOW }).confidence, 'medium', 'four days, a clean line');
  const noisy = forecast(series({ n: 49, everyHours: 6, noise: i => (i % 2 ? 1 : -1) * 120 * GB }), { now: NOW });
  assert.equal(noisy.confidence, 'low'); assert.ok(noisy.fit < 0.7);
  assert.equal(forecast(series({ n: 8, everyHours: 4 }), { now: NOW }).confidence, 'low', 'a day and a half');
});

test('an alert rule is told the days only when the forecast can be trusted, and "no end in sight" when the datastore is not filling', () => {
  const growing = forecast(series(), { now: NOW });
  assert.ok(Math.abs(daysUntilFullForAlert(growing) - 38) < 0.2);
  assert.equal(daysUntilFullForAlert(forecast(series({ perDay: 0 }), { now: NOW })), HORIZON_DAYS);
  assert.equal(daysUntilFullForAlert(forecast(series({ perDay: -5 * GB }), { now: NOW })), HORIZON_DAYS);
  assert.equal(daysUntilFullForAlert(forecast(series({ n: 5 }), { now: NOW })), null, 'not enough history: not reported, not zero');
  assert.equal(daysUntilFullForAlert(forecast(series({ n: 49, noise: i => (i % 2 ? 1 : -1) * 120 * GB }), { now: NOW })), null, 'a low-confidence forecast raises nothing');
  assert.equal(daysUntilFullForAlert(forecast(series({ n: 3, startUsed: CAPACITY }), { now: NOW })), 0);
  assert.equal(daysUntilFullForAlert(null), null);
  assert.equal(daysUntilFullForAlert({ status: 'growing', confidence: 'high', daysUntilFull: null }), HORIZON_DAYS);
});

test('the chart helpers thin a long history evenly and keep the first and last reading', () => {
  const samples = series({ n: 400, everyHours: 1 });
  const t = trend(samples, 28);
  assert.equal(t.length, 28); assert.ok(t[0] < t.at(-1)); assert.ok(t.every(value => value >= 0 && value <= 100));
  assert.equal(trend(samples.slice(0, 5), 28).length, 5); assert.deepEqual(trend([]), []);
  const points = chartPoints(samples, 100);
  assert.equal(points.length, 100); assert.equal(points[0].at, new Date(samples[0].at).toISOString()); assert.equal(points.at(-1).at, new Date(samples.at(-1).at).toISOString());
  assert.deepEqual(Object.keys(points[0]), ['at', 'usedBytes', 'capacityBytes']);
});

test('the sentence for a forecast says what is known and no more', () => {
  assert.match(describeForecast(forecast(series(), { now: NOW })), /^Growing by about 10 GB a day: full in about 38(\.\d)? days$/);
  assert.match(describeForecast(forecast(series({ perDay: 0 }), { now: NOW })), /^Stable/);
  assert.match(describeForecast(forecast(series({ perDay: -20 * GB }), { now: NOW })), /^Shrinking by about 20 GB a day$/);
  assert.match(describeForecast(forecast(series({ n: 3 }), { now: NOW })), /Not enough history/);
  assert.equal(describeForecast(null), 'No forecast');
  assert.match(describeForecast({ status: 'growing', growthBytesPerDay: 1.5 * GB, daysUntilFull: 1 }), /full in about 1 day$/);
  assert.match(describeForecast({ status: 'growing', growthBytesPerDay: 1.5 * GB, daysUntilFull: null }), /not full within ten years$/);
});
