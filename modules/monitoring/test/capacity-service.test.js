import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapacityService } from '../src/capacity-service.js';
import { DAY_MS } from '../src/capacity-rules.js';

// The local capacity store: readings are kept at most every half hour (a change of size always), in time order, for 90 days, survive a restart, and untrustworthy readings are refused.
const GB = 1024 ** 3, NOW = Date.parse('2026-10-21T12:00:00Z'), DS = '11111111-1111-4111-8111-111111111111', DS2 = '22222222-2222-4222-8222-222222222222', CONN = '33333333-3333-4333-8333-333333333333';
const reading = (offsetMinutes, over = {}) => ({ objectId: DS, connectionId: CONN, capacityBytes: 1000 * GB, freeBytes: 400 * GB, observedAt: NOW + offsetMinutes * 60_000, ...over });
const tmp = () => mkdtempSync(join(tmpdir(), 'nuvrion-capacity-'));

test('a reading is recorded once per half hour, in time order, however it arrives', async () => {
  const service = new CapacityService({ clock: () => NOW });
  assert.deepEqual(await service.record([reading(0), reading(5), reading(40), reading(-60)]), { recorded: 3, skipped: 1 });
  const history = (await service.historyFor([DS])).get(DS);
  assert.deepEqual(history.map(sample => sample.at - NOW), [-3_600_000, 0, 2_400_000]);
  assert.deepEqual(history[0], { at: NOW - 3_600_000, capacityBytes: 1000 * GB, usedBytes: 600 * GB });
  assert.deepEqual(await service.record([reading(0)]), { recorded: 0, skipped: 1 }, 'the same moment twice');
});

test('a change of size is recorded at once, so a datastore that was extended shows the new size', async () => {
  const service = new CapacityService({ clock: () => NOW });
  await service.record([reading(0)]);
  assert.deepEqual(await service.record([reading(5, { capacityBytes: 2000 * GB, freeBytes: 1400 * GB })]), { recorded: 1, skipped: 0 });
  assert.deepEqual((await service.historyFor([DS])).get(DS).map(sample => sample.capacityBytes), [1000 * GB, 2000 * GB]);
});

test('readings that cannot be believed are refused and the rest of the batch is kept', async () => {
  const service = new CapacityService({ clock: () => NOW });
  const result = await service.record([reading(0, { freeBytes: 2000 * GB }), reading(0, { capacityBytes: 0 }), reading(0, { observedAt: 'never' }), reading(0, { objectId: '' }), reading(0, { objectId: DS2 })]);
  assert.deepEqual(result, { recorded: 1, skipped: 4 });
  assert.equal((await service.historyFor([DS])).get(DS).length, 0);
  assert.equal((await service.historyFor([DS2])).get(DS2).length, 1);
});

test('history is returned per datastore from a given time, and an unknown datastore has none', async () => {
  const service = new CapacityService({ clock: () => NOW });
  await service.record([reading(-120), reading(-60), reading(0), reading(0, { objectId: DS2 })]);
  const history = await service.historyFor([DS, DS2, '99999999-9999-4999-8999-999999999999'], { sinceMs: NOW - 90 * 60_000 });
  assert.deepEqual([history.get(DS).length, history.get(DS2).length, history.get('99999999-9999-4999-8999-999999999999').length], [2, 1, 0]);
});

test('readings older than 90 days are not kept, and are dropped as time passes', async () => {
  let now = NOW;
  const service = new CapacityService({ clock: () => now });
  assert.deepEqual(await service.record([reading(-91 * 24 * 60), reading(0)]), { recorded: 1, skipped: 1 }, 'too old on arrival');
  now = NOW + 91 * DAY_MS;
  await service.record([reading(91 * 24 * 60)]);
  assert.deepEqual((await service.historyFor([DS])).get(DS).map(sample => sample.at), [NOW + 91 * DAY_MS], 'the first reading aged out');
});

test('the history survives a restart, and a damaged file starts a new one rather than stopping the platform', async () => {
  const dir = tmp(), file = join(dir, 'capacity.json');
  try {
    const first = new CapacityService({ file, clock: () => NOW });
    await first.record([reading(-60), reading(0)]);
    const second = new CapacityService({ file, clock: () => NOW });
    assert.equal((await second.historyFor([DS])).get(DS).length, 2);
    writeFileSync(file, '{ not json');
    const third = new CapacityService({ file, clock: () => NOW });
    assert.equal((await third.historyFor([DS])).get(DS).length, 0);
    assert.deepEqual(await third.record([reading(0)]), { recorded: 1, skipped: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an interval of zero keeps every distinct moment (used by tests to build a history quickly)', async () => {
  const service = new CapacityService({ clock: () => NOW, intervalMs: 0 });
  assert.deepEqual(await service.record([reading(0), reading(1), reading(2)]), { recorded: 3, skipped: 0 });
});

test('processor and memory readings of a host are kept apart from its storage readings and from each other, and an unknown kind of reading is refused', async () => {
  const service = new CapacityService({ clock: () => NOW });
  const at = NOW;
  const result = await service.record([
    { objectId: DS, metric: 'cpu', capacityBytes: 50400, freeBytes: 40600, observedAt: at },       // MHz
    { objectId: DS, metric: 'memory', capacityBytes: 256 * GB, freeBytes: 160 * GB, observedAt: at },
    { objectId: DS, capacityBytes: 1000 * GB, freeBytes: 400 * GB, observedAt: at },                // storage by default
    { objectId: DS, metric: 'network', capacityBytes: 1000, freeBytes: 10, observedAt: at }
  ]);
  assert.deepEqual(result, { recorded: 3, skipped: 1 });
  const of = async metric => (await service.historyFor([DS], { metric })).get(DS);
  assert.deepEqual((await of('cpu')).map(sample => [sample.capacityBytes, sample.usedBytes]), [[50400, 9800]]);
  assert.deepEqual((await of('memory')).map(sample => sample.usedBytes), [96 * GB]);
  assert.deepEqual((await of('storage')).map(sample => sample.usedBytes), [600 * GB]);
  assert.equal((await service.historyFor([DS])).get(DS).length, 1, 'with no metric named, storage');
  assert.deepEqual(await service.record([{ objectId: DS, metric: 'cpu', capacityBytes: 50400, freeBytes: 40000, observedAt: at + 5 * 60_000 }]), { recorded: 0, skipped: 1 }, 'the half-hour rule is per metric');
  assert.deepEqual(await service.record([{ objectId: DS, metric: 'memory', capacityBytes: 256 * GB, freeBytes: 150 * GB, observedAt: at + 40 * 60_000 }]), { recorded: 1, skipped: 0 });
});
