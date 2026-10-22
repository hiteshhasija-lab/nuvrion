import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresViewService } from '../src/postgres-view-service.js';
import { scenarios, T0 } from '../test-support/view-scenarios.js';
import { LIMITS } from '../src/view-rules.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production saved-view store against a real PostgreSQL, as the restricted application role: the behaviour of the local store plus what only a database can get wrong (the limit under
// concurrent saves, a view going with its owner, the table refusing what the rules refuse).
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const time = { now: T0 };
const service = db ? new PostgresViewService(db.pool, { clock: () => time.now }) : null;
let ann, bob;
const makeUser = async name => (await db.adminPool.query("INSERT INTO identity.users (user_id, username, normalized_username, display_name, status, password_hash) VALUES (gen_random_uuid(),$1,$1,$1,'active','x') RETURNING user_id", [name])).rows[0].user_id;
after(async () => { await db?.drop(); });
beforeEach(async () => {
  if (!db) return;
  await db.adminPool.query('DELETE FROM inventory.saved_views');
  await db.adminPool.query('DELETE FROM identity.users WHERE username IN ($1,$2)', ['ann-views', 'bob-views']);
  ann = await makeUser('ann-views'); bob = await makeUser('bob-views'); time.now = T0;
});
for (const [name, run] of Object.entries(scenarios)) test(`PostgreSQL: ${name}`, database, async () => { await run({ service, time, ann, bob }); });

test('PostgreSQL: twenty saves at once leave at most twenty views, and the same name saved twice at once is one view', database, async () => {
  const results = await Promise.allSettled(Array.from({ length: LIMITS.perPerson + 6 }, (_, i) => service.createView(ann, { name: `Concurrent ${i}`, view: {} })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, LIMITS.perPerson);
  assert.equal((await service.listViews(ann)).length, LIMITS.perPerson);
  const same = await Promise.allSettled([service.createView(bob, { name: 'Same', view: {} }), service.createView(bob, { name: 'same', view: {} })]);
  assert.equal(same.filter(result => result.status === 'fulfilled').length, 1);
});

test('PostgreSQL: a view goes with its owner, and the table refuses what the rules refuse', database, async () => {
  const created = await service.createView(ann, { name: 'Mine', view: {} });
  await assert.rejects(db.pool.query("UPDATE inventory.saved_views SET scope='audit' WHERE view_id=$1", [created.id]), /check|violates/i);
  await db.adminPool.query('DELETE FROM identity.users WHERE user_id=$1', [ann]);
  assert.equal((await db.adminPool.query('SELECT count(*)::int n FROM inventory.saved_views WHERE view_id=$1', [created.id])).rows[0].n, 0);
});
