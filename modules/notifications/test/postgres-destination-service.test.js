import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDestinationService } from '../src/postgres-destination-service.js';
import { scenarios, T0 } from '../test-support/store-scenarios.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production webhook store against a real PostgreSQL, as the restricted application role: every behaviour of the local store (test-support/store-scenarios.js), plus what only a
// database can get wrong (two senders claiming the same delivery, the sealed address at rest, a sealed address moved to another row).
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const time = { now: T0 };
const service = db ? new PostgresDestinationService(db.pool, { clock: () => time.now }) : null;
after(async () => { await db?.drop(); });
beforeEach(async () => { if (!db) return; await db.adminPool.query('DELETE FROM monitoring.webhook_deliveries; DELETE FROM monitoring.webhook_destinations'); time.now = T0; });
for (const [name, run] of Object.entries(scenarios())) test(`PostgreSQL: ${name}`, database, async () => { await run({ service, time }); });

test('PostgreSQL: the address is stored sealed, never as written', database, async () => {
  const created = await service.createDestination({ name: 'Ops', url: 'https://hooks.example.com/services/very-secret-token', signingSecret: 'a-long-signing-secret' }, null);   // secret-scan:allow (fake test credential)
  const row = (await db.adminPool.query('SELECT * FROM monitoring.webhook_destinations WHERE destination_id=$1', [created.id])).rows[0];
  const stored = JSON.stringify(row);
  assert.equal(stored.includes('very-secret-token') || stored.includes('a-long-signing-secret'), false);
  assert.deepEqual([row.url_hint, row.has_signing_secret, Buffer.isBuffer(row.secret_ciphertext)], ['https://hooks.example.com/…', true, true]);
});

test('PostgreSQL: a sealed address moved to another row cannot be opened', database, async () => {
  const a = await service.createDestination({ name: 'A', url: 'https://a.example.com/x' }, null), b = await service.createDestination({ name: 'B', url: 'https://b.example.com/y' }, null);
  await db.adminPool.query(`UPDATE monitoring.webhook_destinations t SET secret_key_id=s.secret_key_id, secret_nonce=s.secret_nonce, secret_ciphertext=s.secret_ciphertext, secret_tag=s.secret_tag FROM monitoring.webhook_destinations s WHERE t.destination_id=$1 AND s.destination_id=$2`, [a.id, b.id]);
  await assert.rejects(service.secretsOf(a.id));
  assert.deepEqual(await service.secretsOf(b.id), { url: 'https://b.example.com/y', signingSecret: null });
});

test('PostgreSQL: two senders asking at once get different deliveries, and none twice', database, async () => {
  const created = await service.createDestination({ name: 'Ops', url: 'https://hooks.example.com/x' }, null);
  await service.enqueue(created.id, Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, type: 'alert.fired', at: new Date(T0).toISOString(), severity: 'critical', title: `t${i}`, detail: '' })), time.now);
  const [x, y] = await Promise.all([service.claimDue(6, time.now), service.claimDue(6, time.now)]);
  const ids = [...x, ...y].map(delivery => delivery.id);
  assert.equal(new Set(ids).size, ids.length, 'no delivery claimed twice'); assert.equal(ids.length, 10);
});

test('PostgreSQL: the same event queued at once from two senders is one delivery; the table refuses what the rules refuse', database, async () => {
  const created = await service.createDestination({ name: 'Ops', url: 'https://hooks.example.com/x' }, null);
  const same = { id: 'dup', type: 'alert.fired', at: new Date(T0).toISOString(), severity: 'critical', title: 't', detail: '' };
  const counts = await Promise.all([service.enqueue(created.id, [same], time.now), service.enqueue(created.id, [same], time.now)]);
  assert.equal(counts[0] + counts[1], 1);
  await assert.rejects(db.pool.query("UPDATE monitoring.webhook_destinations SET format='xml' WHERE destination_id=$1", [created.id]), /check|violates/i);
  await assert.rejects(db.pool.query("UPDATE monitoring.webhook_deliveries SET status='lost' WHERE destination_id=$1", [created.id]), /check|violates/i);
});
