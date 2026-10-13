import { readdir, readFile } from 'node:fs/promises';

// node tools/check-migrations.js [directory]
// Every migration is one transaction; the numbers are contiguous from 0001; and every migration from 0029 on records itself in the ledger
// (platform.schema_migrations), which the readiness check compares with the newest migration that ships.
const dir = process.argv[2] ? new URL(`file://${process.argv[2].replace(/\/?$/, '/')}`) : new URL('../database/migrations/', import.meta.url);
const files = (await readdir(dir)).filter(x => x.endsWith('.sql')).sort();
if (!files.length) throw new Error('No migrations found');
const problems = [];
files.forEach((file, index) => {
  const expected = String(index + 1).padStart(4, '0');
  if (!file.startsWith(`${expected}_`)) problems.push(`${file}: expected a migration numbered ${expected} (numbers must be contiguous from 0001)`);
});
for (const file of files) {
  const sql = await readFile(new URL(file, dir), 'utf8');
  if (!sql.includes('BEGIN;') || !sql.includes('COMMIT;')) problems.push(`${file} is not transactional`);
  const number = Number(file.slice(0, 4));
  if (number >= 29 && !sql.includes('platform.schema_migrations')) problems.push(`${file} does not record itself in platform.schema_migrations (from 0029 on every migration must)`);
  if (number >= 29 && !sql.includes(`'${file.slice(0, 4)}'`)) problems.push(`${file} does not record its own version '${file.slice(0, 4)}'`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Validated ${files.length} migration(s): ${files[0]} ... ${files.at(-1)}`);
