import { readdirSync } from 'node:fs';

// The migrations that ship with this build. The database must have recorded the newest of them (platform.schema_migrations) before the platform
// reports itself ready: the version is read from the files, so it cannot go stale the way a constant in the code did (it said 0027 while 0028 existed).
const defaultDirectory = new URL('../../../database/migrations/', import.meta.url);

export function migrationVersions(directory = defaultDirectory) {
  return readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).map(name => name.slice(0, 4)).sort();
}

export function latestMigrationVersion(directory = defaultDirectory) {
  const versions = migrationVersions(directory);
  if (!versions.length) throw new Error('No database migrations ship with this build.');
  return versions.at(-1);
}
