import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresTagService } from '../src/postgres-tag-service.js';
import { TagError } from '../src/tag-rules.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production tag store against a real PostgreSQL, running as the restricted application role like the API does: the same behaviour as the file-backed store,
// what the table itself refuses, deletion with the resource, and the one thing only a database can get wrong: two writers at once.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const tags = db ? new PostgresTagService(db.pool) : null;
after(async () => { await db?.drop(); });

let ids = [];
const seedResources = async count => {
  const connection = randomUUID();
  await db.adminPool.query("INSERT INTO connections.provider_connections(connection_id, name, provider_type, connection_type, status, health_state) VALUES($1, $2, 'vmware_workstation', 'workstation_agent', 'enabled', 'healthy')", [connection, `Lab ${connection.slice(0, 8)}`]);
  const made = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    await db.adminPool.query("INSERT INTO inventory.resources(resource_id, connection_id, resource_type, native_id, name, lifecycle_state, health_state, observed_at, first_seen_at, last_seen_at) VALUES($1, $2, 'virtual_machine', $3, $4, 'active', 'healthy', now(), now(), now())", [id, connection, `native-${i}`, `vm-${i}`]);
    made.push(id);
  }
  return made;
};
beforeEach(async () => { if (!db) return; await db.adminPool.query('TRUNCATE inventory.resource_tags, inventory.resources CASCADE'); ids = await seedResources(3); });
const rows = async () => (await db.adminPool.query('SELECT resource_id, tag_key, tag_value FROM inventory.resource_tags ORDER BY resource_id, tag_key')).rows;

test('tags are set on several resources at once, read back sorted with their source, and summarised in a catalog', database, async () => {
  const [a, b, c] = ids;
  const plan = await tags.apply({ resourceIds: [a, b], set: [{ key: 'env', value: 'prod' }, { key: 'team', value: 'core' }] });
  assert.deepEqual(plan.map(entry => entry.changedAnything), [true, true]);
  await tags.apply({ resourceIds: [b], set: [{ key: 'Env', value: 'staging' }] });
  const read = await tags.forResources([a, b, c]);
  assert.deepEqual(read.get(a), [{ key: 'env', value: 'prod', source: 'nuvrion' }, { key: 'team', value: 'core', source: 'nuvrion' }]);
  assert.equal(read.get(b).find(tag => tag.key === 'env').value, 'staging');
  assert.equal(read.has(c), false);
  assert.deepEqual(await tags.catalog(), [
    { key: 'env', resourceCount: 2, values: [{ value: 'prod', count: 1 }, { value: 'staging', count: 1 }] },
    { key: 'team', resourceCount: 2, values: [{ value: 'core', count: 2 }] }]);
  assert.deepEqual([...(await tags.forResources([])).keys()], [], 'asking for no resources is not an error');
});

test('setting what is there changes nothing (the row keeps its time), a new value updates the row, remove deletes it', database, async () => {
  const [a] = ids;
  await tags.apply({ resourceIds: [a], set: [{ key: 'env', value: 'prod' }] });
  const first = (await db.adminPool.query('SELECT updated_at FROM inventory.resource_tags')).rows[0].updated_at;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await tags.apply({ resourceIds: [a], set: [{ key: 'env', value: 'prod' }], remove: ['absent'] }))[0].changedAnything, false);
  assert.deepEqual((await db.adminPool.query('SELECT updated_at FROM inventory.resource_tags')).rows[0].updated_at, first);
  await tags.apply({ resourceIds: [a], set: [{ key: 'env', value: 'staging' }] });
  assert.ok((await db.adminPool.query('SELECT updated_at FROM inventory.resource_tags')).rows[0].updated_at > first, 'a changed value moves updated_at');
  await tags.apply({ resourceIds: [a], remove: ['env'] });
  assert.deepEqual(await rows(), []);
});

test('the table keeps a bad row out whatever writes it: keys must be lower case and plain, values at most 128 characters, one row per resource and key', database, async () => {
  const [a] = ids;
  const insert = (key, value = '') => db.adminPool.query('INSERT INTO inventory.resource_tags(resource_id, tag_key, tag_value) VALUES($1, $2, $3)', [a, key, value]);
  for (const bad of ['Env', 'has space', '-lead', '', 'a=b']) await assert.rejects(() => insert(bad), /resource_tags_tag_key_check|violates check/, `key ${JSON.stringify(bad)}`);
  await assert.rejects(() => insert('k'.repeat(65)), /too long|value too long/);
  await assert.rejects(() => insert('ok', 'v'.repeat(129)), /too long/);
  await insert('ok', 'fine');
  await assert.rejects(() => insert('ok', 'again'), /duplicate key|primary key|resource_tags_pkey/);
  await assert.rejects(() => db.adminPool.query("INSERT INTO inventory.resource_tags(resource_id, tag_key) VALUES($1, 'orphan')", [randomUUID()]), /foreign key/);
});

test('a refused request changes none of the resources, and a failure part way through is rolled back', database, async () => {
  const [a, b] = ids;
  const fifty = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: '' }));
  for (let start = 0; start < 50; start += 20) await tags.apply({ resourceIds: [a], set: fifty.slice(start, start + 20) });
  await assert.rejects(() => tags.apply({ resourceIds: [b, a], set: [{ key: 'extra', value: '1' }] }), error => error instanceof TagError && error.code === 'NUV_TAG_LIMIT_EXCEEDED');
  assert.equal((await rows()).filter(row => row.resource_id === b).length, 0, 'b, listed first, was not changed');
  await assert.rejects(() => tags.apply({ resourceIds: [b], set: [{ key: 'Bad Key' }] }), TagError);
  await assert.rejects(() => tags.apply({ resourceIds: [b, randomUUID()], set: [{ key: 'ghost', value: '1' }] }), /foreign key/, 'an id that is not a resource fails at the table');
  assert.equal((await rows()).filter(row => row.tag_key === 'ghost').length, 0, 'and the part that had already been written is rolled back');
  assert.equal((await rows()).filter(row => row.resource_id === a).length, 50);
});

test('two writers at the same moment cannot together take a resource over 50 tags', database, async () => {
  const [a] = ids;
  const batch = prefix => ({ resourceIds: [a], set: Array.from({ length: 20 }, (_, i) => ({ key: `${prefix}${i}`, value: '' })) });
  const outcomes = await Promise.allSettled(['p', 'q', 'r'].map(prefix => tags.apply(batch(prefix))));
  const accepted = outcomes.filter(o => o.status === 'fulfilled').length;
  assert.equal(accepted, 2, 'two batches of 20 fit, the third would make 60');
  assert.ok(outcomes.filter(o => o.status === 'rejected').every(o => o.reason.code === 'NUV_TAG_LIMIT_EXCEEDED'));
  assert.equal((await rows()).length, 40);
});

test('tags go with their resource when it is deleted, and the application role can do all of this without schema rights', database, async () => {
  const [a, b] = ids;
  await tags.apply({ resourceIds: [a, b], set: [{ key: 'env', value: 'prod' }] });
  await db.adminPool.query('DELETE FROM inventory.resources WHERE resource_id = $1', [a]);
  assert.deepEqual((await rows()).map(row => row.resource_id), [b]);
  await assert.rejects(() => db.pool.query('ALTER TABLE inventory.resource_tags ADD COLUMN x int'), /must be owner|permission denied/);
  assert.equal(await tags.forget([b]), 0);
});
