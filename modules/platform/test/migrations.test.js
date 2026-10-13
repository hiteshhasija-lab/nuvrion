import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestMigrationVersion, migrationVersions } from '../src/migrations.js';

// The newest migration that ships is read from the files, so the readiness check cannot go stale; and the validator keeps every later migration
// recording itself in the ledger.
const tool = new URL('../../../tools/check-migrations.js', import.meta.url).pathname;
const migration = (version, { record = true, transactional = true } = {}) =>
  `${transactional ? 'BEGIN;\n' : ''}SELECT 1;\n${record ? `INSERT INTO platform.schema_migrations(version,description,checksum) VALUES ('${version}','x','y') ON CONFLICT DO NOTHING;\n` : ''}${transactional ? 'COMMIT;\n' : ''}`;
function directory(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-migrations-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const validate = dir => spawnSync(process.execPath, [tool, dir], { encoding: 'utf8' });
const withDirectory = (files, run) => { const dir = directory(files); try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const base = () => Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`${String(i + 1).padStart(4, '0')}_m.sql`, migration(String(i + 1).padStart(4, '0'), { record: false })]));

test('the newest migration is read from the files that ship, and the real directory ends at or after 0029', () => {
  assert.equal(latestMigrationVersion(), migrationVersions().at(-1));
  assert.ok(latestMigrationVersion() >= '0029');
  const files = readdirSync(new URL('../../../database/migrations/', import.meta.url)).filter(name => name.endsWith('.sql'));
  assert.equal(migrationVersions().length, files.length);
});

test('versions are the four-digit prefixes of the .sql files, sorted; other files are ignored; an empty directory is an error', () => {
  withDirectory({ '0002_b.sql': '', '0001_a.sql': '', 'README.md': '', 'notes.txt': '', '12_short.sql': '', '0003_c.sql': '' }, dir => {
    assert.deepEqual(migrationVersions(dir), ['0001', '0002', '0003']);
    assert.equal(latestMigrationVersion(dir), '0003');
  });
  withDirectory({ 'README.md': '' }, dir => assert.throws(() => latestMigrationVersion(dir), /No database migrations/));
});

test('the validator accepts contiguous, transactional migrations whose later ones record themselves', () => {
  withDirectory({ ...base(), '0029_ledger.sql': migration('0029'), '0030_next.sql': migration('0030') }, dir => {
    const result = validate(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated 30 migration/);
  });
});

test('the validator refuses a gap or a duplicate number, a migration that is not transactional, and a later migration that does not record itself', () => {
  const cases = [
    ['a gap', { ...base(), '0030_skips.sql': migration('0030') }, /expected a migration numbered 0029/],
    ['a duplicate number', { ...base(), '0029_a.sql': migration('0029'), '0029_b.sql': migration('0029') }, /expected a migration numbered 0030/],
    ['not transactional', { ...base(), '0029_x.sql': migration('0029', { transactional: false }) }, /is not transactional/],
    ['does not record itself', { ...base(), '0029_x.sql': migration('0029', { record: false }) }, /does not record itself/],
    ['records another version', { ...base(), '0029_x.sql': migration('0099') }, /does not record its own version '0029'/]
  ];
  for (const [label, files, pattern] of cases) withDirectory(files, dir => {
    const result = validate(dir);
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, pattern, label);
  });
});

test('an old migration (before the ledger existed) does not have to record itself', () => {
  withDirectory(base(), dir => assert.equal(validate(dir).status, 0));
});
