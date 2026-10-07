import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresConnectionService } from '../src/postgres-connection-service.js';
import { createTestDatabase, skipDatabaseTests } from '../../../database/test-support/test-database.js';

// The production connection service against a real PostgreSQL: encrypted credentials, versioned updates, health, failure counting,
// retry timing, and the alerts raised, acknowledged and recovered along the way.
const database = { skip: skipDatabaseTests };
const db = skipDatabaseTests ? null : await createTestDatabase();
const events = [];
const service = db ? new PostgresConnectionService(db.pool, { masterKey: 'contract-test-master-key', onAlert: event => events.push(`${event.type}:${event.alert.connectionName}`) }) : null; // secret-scan:allow (fake test key)
after(async () => { await db?.drop(); });
beforeEach(async () => {
  if (!db) return;
  events.length = 0;
  await db.pool.query('TRUNCATE connections.health_alerts, connections.health_events, inventory.provider_metadata, inventory.virtual_machines, inventory.resources, connections.provider_connections, connections.secret_versions, connections.secret_references CASCADE');
});

const CREDENTIAL = { username: 'svc-nuvrion', password: 'Sup3r-Secret-Value-123' }; // secret-scan:allow (fake test credential)
let counter = 0;
const input = (over = {}) => ({ name: `Lab ${++counter}`, providerType: 'vmware_workstation', connectionType: 'workstation_agent', endpointUri: null, credential: CREDENTIAL, configuration: { vmSearchRoots: ['C:\\VMs'] }, ...over });
const count = async table => (await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const user = async () => { const id = randomUUID(); await db.pool.query("INSERT INTO identity.users(user_id, username, normalized_username, display_name, status, password_hash) VALUES($1, $2, $2, 'Op', 'active', 'x')", [id, `op-${id.slice(0, 8)}`]); return id; };

test('a new connection is stored with its credential encrypted, and the credential is never returned', database, async () => {
  const created = await service.create(input({ name: '  Padded name  ' }));
  assert.equal(created.name, 'Padded name');
  assert.deepEqual([created.status, created.healthState, created.rowVersion, created.consecutiveFailures, created.resourceCount], ['enabled', 'unknown', 1, 0, 0]);
  assert.equal(created.etag, '"1"');
  assert.deepEqual(created.configuration, { vmSearchRoots: ['C:\\VMs'] });
  assert.equal(JSON.stringify(created).includes('Sup3r'), false, 'the credential is not in the returned record');
  const stored = (await db.pool.query('SELECT algorithm, key_id, ciphertext, nonce, auth_tag FROM connections.secret_versions')).rows[0];
  assert.equal(stored.algorithm, 'aes-256-gcm');
  assert.equal(stored.ciphertext.toString('utf8').includes('Sup3r'), false, 'only ciphertext is stored');
  assert.equal(stored.ciphertext.toString('base64').includes(Buffer.from('Sup3r').toString('base64')), false);
  assert.deepEqual(await service.resolveCredential(created.id), CREDENTIAL, 'it can be decrypted when needed');
});

test('an invalid connection is refused and leaves nothing behind', database, async () => {
  for (const bad of [{ name: '   ' }, { name: undefined }, { providerType: 'oracle_cloud' }, { credential: undefined }, { credential: null }]) {
    await assert.rejects(() => service.create(input(bad)), /CONNECTION_INVALID/, JSON.stringify(Object.keys(bad)));
  }
  assert.deepEqual([await count('connections.provider_connections'), await count('connections.secret_references'), await count('connections.secret_versions')], [0, 0, 0]);
});

test('creating a connection is atomic: a database error after the secret was written removes the secret too', database, async () => {
  await assert.rejects(() => service.create(input({ connectionType: undefined })));   // connection_type is NOT NULL, so the last insert fails
  assert.deepEqual([await count('connections.provider_connections'), await count('connections.secret_references'), await count('connections.secret_versions')], [0, 0, 0]);
});

test('connections are listed by name without the deleted ones, and counted with their resources', database, async () => {
  const b = await service.create(input({ name: 'B lab' })), a = await service.create(input({ name: 'A lab' })), gone = await service.create(input({ name: 'C lab' }));
  await db.pool.query("INSERT INTO inventory.resources(resource_id, connection_id, resource_type, native_id, name, lifecycle_state, health_state, observed_at, first_seen_at, last_seen_at, row_version) VALUES($1, $2, 'virtual_machine', 'n1', 'VM', 'active', 'healthy', now(), now(), now(), 1)", [randomUUID(), a.id]);
  await service.remove(gone.id);
  const listed = await service.list();
  assert.deepEqual(listed.map(c => c.name), ['A lab', 'B lab']);
  assert.equal(listed[0].resourceCount, 1);
  assert.equal(await service.get(gone.id), null, 'a deleted connection is not found');
  assert.equal(await service.get(randomUUID()), null);
  assert.equal((await service.get(b.id)).name, 'B lab');
});

test('removing a connection hides it, stops its retries, recovers its alert and forgets its credential', database, async () => {
  const c = await service.create(input());
  await service.recordFailure(c.id, 'NUV_TEST_DOWN', 60_000);
  assert.equal(await count('connections.health_alerts'), 1);
  const removed = await service.remove(c.id);
  assert.equal(removed.status, 'deleted');
  assert.equal(removed.healthState, 'unknown');
  assert.equal(removed.nextRetryAt, null);
  assert.equal((await db.pool.query("SELECT status FROM connections.health_alerts")).rows[0].status, 'recovered');
  assert.deepEqual(events, [`created:${c.name}`, `recovered:${c.name}`], 'the alert was announced, then its recovery was');
  assert.equal(await service.resolveCredential(c.id), null, 'a removed connection\'s credential cannot be resolved');
  assert.equal(await service.remove(c.id), null, 'removing twice does nothing');
});

test('replacing the credential needs the current version; the old version is kept and the new one is used', database, async () => {
  const c = await service.create(input());
  await assert.rejects(() => service.replaceCredential(c.id, { username: 'x', password: 'y' }, c.rowVersion + 3), /VERSION_CONFLICT/);
  assert.deepEqual(await service.resolveCredential(c.id), CREDENTIAL, 'a refused replacement changes nothing');
  assert.equal(await count('connections.secret_versions'), 1);
  const next = { username: 'svc-nuvrion', password: 'Rotated-Value-456' }; // secret-scan:allow (fake test credential)
  await service.recordFailure(c.id, 'NUV_AUTH', 30_000);
  const current = await service.get(c.id);
  const replaced = await service.replaceCredential(c.id, next, current.rowVersion);
  assert.equal(replaced.rowVersion, current.rowVersion + 1);
  assert.equal(replaced.nextRetryAt, null, 'a new credential means try again at once');
  assert.deepEqual(await service.resolveCredential(c.id), next);
  assert.equal(await count('connections.secret_versions'), 2, 'the old version stays in the table');
  assert.equal((await db.pool.query('SELECT current_version FROM connections.secret_references')).rows[0].current_version, 2);
  assert.equal(await service.replaceCredential(randomUUID(), next, 1), null);
});

test('two people replacing the credential at once: exactly one wins, the other is told the connection changed', database, async () => {
  const c = await service.create(input());
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => service.replaceCredential(c.id, { username: 'u', password: `candidate-${i}-value` }, c.rowVersion))); // secret-scan:allow (fake test credential)
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const failed of results.filter(r => r.status === 'rejected')) assert.match(failed.reason.message, /VERSION_CONFLICT/);
  assert.equal(await count('connections.secret_versions'), 2, 'one new version, not several');
});

test('updating a connection changes its name and address, clears the retry time, and refuses a blank name', database, async () => {
  const c = await service.create(input({ endpointUri: 'https://a.example' }));
  await service.recordFailure(c.id, 'NUV_DOWN', 60_000);
  const renamed = await service.update(c.id, { name: '  New name  ' });
  assert.equal(renamed.name, 'New name');
  assert.equal(renamed.endpointUri, 'https://a.example', 'an address that was not mentioned is kept');
  assert.equal(renamed.nextRetryAt, null);
  assert.equal((await service.update(c.id, { endpointUri: 'https://b.example' })).endpointUri, 'https://b.example');
  assert.equal((await service.update(c.id, { endpointUri: null })).endpointUri, null, 'null clears the address');
  await assert.rejects(() => service.update(c.id, { name: '   ' }), /CONNECTION_INVALID/);
  assert.equal(await service.update(randomUUID(), { name: 'x' }), null);
  await service.remove(c.id);
  assert.equal(await service.update(c.id, { name: 'back' }), null, 'a deleted connection cannot be edited');
});

test('trust pins are merged into the configuration without losing what is there', database, async () => {
  const c = await service.create(input({ configuration: { adapter: 'keep-me' } }));
  const pinned = await service.recordTrustPin(c.id, { tlsCertificateSha256: 'AA:BB' });
  assert.deepEqual(pinned.configuration, { adapter: 'keep-me', tlsCertificateSha256: 'AA:BB' });
  assert.equal(pinned.rowVersion, c.rowVersion + 1);
  const unchanged = await service.recordTrustPin(c.id, {});
  assert.equal(unchanged.rowVersion, pinned.rowVersion, 'an empty pin changes nothing');
});

test('failures are counted: unhealthy at first, critical from the third, with a retry time and an error code', database, async () => {
  const c = await service.create(input());
  const first = await service.recordFailure(c.id, 'NUV_ESXI_UNREACHABLE', 5000);
  assert.deepEqual([first.healthState, first.consecutiveFailures, first.lastErrorCode], ['unhealthy', 1, 'NUV_ESXI_UNREACHABLE']);
  assert.ok(Date.parse(first.nextRetryAt) > Date.now() + 3000, 'the retry is scheduled after the delay');
  assert.equal((await service.recordFailure(c.id, 'NUV_ESXI_UNREACHABLE', 10_000)).healthState, 'unhealthy');
  const third = await service.recordFailure(c.id, 'NUV_ESXI_UNREACHABLE', null);
  assert.deepEqual([third.healthState, third.consecutiveFailures, third.nextRetryAt], ['critical', 3, null]);
  assert.equal(await service.recordFailure(randomUUID(), 'X'), null, 'an unknown connection is ignored');
});

test('failures raise one alert per connection, which counts further failures instead of piling up', database, async () => {
  const c = await service.create(input()), other = await service.create(input());
  await service.recordFailure(c.id, 'NUV_A');
  await service.recordFailure(c.id, 'NUV_B');
  await service.recordFailure(c.id, 'NUV_B');
  await service.recordFailure(other.id, 'NUV_C');
  const alerts = await service.alerts();
  assert.equal(alerts.length, 2, 'one alert per connection');
  const mine = alerts.find(a => a.connectionId === c.id);
  assert.deepEqual([mine.occurrenceCount, mine.severity, mine.errorCode, mine.status, mine.connectionName], [3, 'critical', 'NUV_B', 'active', c.name], 'it escalated to critical and took the latest error');
  assert.deepEqual(events, [`created:${c.name}`, `created:${other.name}`], 'a second failure does not announce a new alert');
});

test('failures reported at the same moment are all counted, and still make only one alert', database, async () => {
  const c = await service.create(input());
  await Promise.all(Array.from({ length: 12 }, () => service.recordFailure(c.id, 'NUV_RACE')));
  assert.equal((await service.get(c.id)).consecutiveFailures, 12, 'no failure is lost');
  const alerts = await service.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].occurrenceCount, 12);
  assert.equal(events.filter(e => e.startsWith('created')).length, 1, 'announced once');
});

test('a successful sync or a healthy report resets the failures and recovers the alert; an unhealthy report does not', database, async () => {
  const c = await service.create(input());
  await service.recordFailure(c.id, 'NUV_DOWN', 5000); await service.recordFailure(c.id, 'NUV_DOWN', 5000);
  await service.recordHealth(c.id, 'degraded');
  let now = await service.get(c.id);
  assert.deepEqual([now.healthState, now.consecutiveFailures, now.lastErrorCode], ['degraded', 2, 'NUV_DOWN'], 'a non-healthy report keeps the failure record');
  assert.equal((await service.alerts({ status: 'active' })).length, 1);
  await service.recordSync(c.id, 5);
  now = await service.get(c.id);
  assert.deepEqual([now.healthState, now.consecutiveFailures, now.lastErrorCode, now.nextRetryAt], ['healthy', 0, null, null]);
  assert.ok(now.lastSyncAt && now.lastSuccessAt);
  assert.equal((await service.alerts({ status: 'active' })).length, 0);
  assert.equal((await service.alerts({ status: 'recovered' })).length, 1);
  assert.deepEqual(events.map(e => e.split(':')[0]), ['created', 'recovered']);
  await service.recordFailure(c.id, 'NUV_DOWN');
  await service.recordHealth(c.id, 'healthy');
  assert.equal((await service.get(c.id)).consecutiveFailures, 0);
  assert.equal((await service.alerts({ status: 'recovered' })).length, 2);
});

test('after recovery a new failure opens a new alert, and the old one stays as history', database, async () => {
  const c = await service.create(input());
  await service.recordFailure(c.id, 'NUV_ONE'); await service.recordSync(c.id, 1); await service.recordFailure(c.id, 'NUV_TWO');
  const alerts = await service.alerts();
  assert.deepEqual(alerts.map(a => [a.status, a.errorCode]), [['active', 'NUV_TWO'], ['recovered', 'NUV_ONE']], 'newest first');
  assert.notEqual(alerts[0].id, alerts[1].id);
  assert.equal(await count('connections.health_alerts'), 2);
});

test('an alert can be acknowledged once; a recovered or unknown alert cannot, and an acknowledged one still recovers', database, async () => {
  const c = await service.create(input()), operator = await user();
  await service.recordFailure(c.id, 'NUV_DOWN');
  const [alert] = await service.alerts();
  const acknowledged = await service.acknowledgeAlert(alert.id, operator);
  assert.deepEqual([acknowledged.status, acknowledged.acknowledgedBy], ['acknowledged', operator]);
  assert.ok(acknowledged.acknowledgedAt);
  const again = await service.acknowledgeAlert(alert.id, await user());
  assert.equal(again.acknowledgedBy, operator, 'a second acknowledgement does not take over');
  await service.recordFailure(c.id, 'NUV_DOWN');
  assert.equal((await service.alerts({ status: 'acknowledged' })).length, 1, 'more failures keep the same acknowledged alert');
  assert.equal((await service.alerts()).length, 1);
  await service.recordSync(c.id, 1);
  const recovered = (await service.alerts())[0];
  assert.equal(recovered.status, 'recovered');
  assert.equal((await service.acknowledgeAlert(alert.id, operator)).status, 'recovered', 'a recovered alert stays recovered');
  assert.equal(await service.acknowledgeAlert(randomUUID(), operator), null);
});

test('alerts can be filtered by state and limited, newest first, and carry the connection name', database, async () => {
  const names = [];
  for (let i = 0; i < 4; i++) { const c = await service.create(input({ name: `Alerting ${i}` })); names.push(c.name); await service.recordFailure(c.id, `NUV_${i}`); if (i < 2) await service.recordSync(c.id, 1); }
  assert.equal((await service.alerts()).length, 4);
  assert.equal((await service.alerts({ status: 'active' })).length, 2);
  assert.equal((await service.alerts({ status: 'recovered' })).length, 2);
  const limited = await service.alerts({ limit: 2 });
  assert.deepEqual(limited.map(a => a.connectionName), ['Alerting 3', 'Alerting 2']);
  assert.equal((await service.alerts({ limit: 0 })).length, 1, 'a limit below 1 is raised to 1');
});

test('check results are recorded and listed newest first, with the limit kept between 1 and 100', database, async () => {
  const c = await service.create(input());
  const first = await service.recordDiagnostic(c.id, { checkType: 'test', outcome: 'succeeded', durationMs: 12.6 });
  assert.equal(first.durationMs, 13, 'durations are rounded');
  assert.equal((await service.recordDiagnostic(c.id, { checkType: 'discovery', outcome: 'failed', errorCode: 'NUV_X', durationMs: -5 })).durationMs, 0, 'a negative duration becomes 0');
  for (let i = 0; i < 4; i++) await service.recordDiagnostic(c.id, { checkType: 'scheduled_discovery', outcome: 'succeeded', durationMs: i });
  const listed = await service.diagnostics(c.id, 3);
  assert.equal(listed.length, 3);
  assert.ok(listed[0].checkedAt >= listed[2].checkedAt, 'newest first');
  assert.equal((await service.diagnostics(c.id, 0)).length, 1);
  assert.equal((await service.diagnostics(c.id, 100000)).length, 6);
  await assert.rejects(() => service.recordDiagnostic(c.id, { checkType: 'unknown-kind', outcome: 'succeeded' }), error => error.code === '23514', 'the database refuses an unknown check type');
});

test('a different key cannot read a stored credential, and a tampered one is rejected', database, async () => {
  const c = await service.create(input());
  const stranger = new PostgresConnectionService(db.pool, { masterKey: 'a-completely-different-key' }); // secret-scan:allow (fake test key)
  await assert.rejects(() => stranger.resolveCredential(c.id), /Unsupported state|authenticate data|NUV_/i);
  await db.pool.query("UPDATE connections.secret_versions SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 255)");
  await assert.rejects(() => service.resolveCredential(c.id), /Unsupported state|authenticate data|NUV_/i, 'a flipped byte is detected');
});
