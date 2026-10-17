// Configuration of the machine that pulls backups and release evidence from the host (docs/backups.md). Kept in ~/.config/nuvrion-backup/config.json, outside any
// folder that is synced or committed; the recovery PRIVATE key is referenced from here but must not live next to the backups.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'nuvrion-backup', 'config.json');
const expand = path => String(path).replace(/^~(?=\/|$)/, homedir());
const SAFE_REMOTE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const SAFE_HOST = /^[A-Za-z0-9._-]+$/;

export class BackupConfigError extends Error {
  constructor(message) { super(message); this.code = 'NUV_BACKUP_CONFIG'; }
}

export function normaliseConfig(raw) {
  const config = {
    host: raw.host, user: raw.user, identityFile: expand(raw.identityFile ?? '~/.ssh/id_ed25519'),
    remoteBackupRoot: raw.remoteBackupRoot ?? 'nuvrion-backups', remoteReleases: raw.remoteReleases ?? 'nuvrion-upgrades/releases',
    destination: expand(raw.destination), signingPublicKeyFile: expand(raw.signingPublicKeyFile ?? '~/.config/nuvrion-backup/host-signing-public.pem'),
    recoveryKeyFile: expand(raw.recoveryKeyFile ?? '~/.config/nuvrion-backup/recovery-key.pem'),
    retention: { hourly: 48, daily: 30, weekly: 26, ...(raw.retention ?? {}) },
    maxAgeHours: raw.maxAgeHours ?? 3,
    immutable: raw.immutable !== false   // macOS immutable and append-only flags on the evidence archive; false switches them off
  };
  if (!SAFE_HOST.test(String(config.host ?? ''))) throw new BackupConfigError('host is missing or not a host name');
  if (!SAFE_HOST.test(String(config.user ?? ''))) throw new BackupConfigError('user is missing or not a user name');
  for (const key of ['remoteBackupRoot', 'remoteReleases']) if (!SAFE_REMOTE_PATH.test(config[key]) || config[key].includes('..')) throw new BackupConfigError(`${key} is not a plain relative path`);
  if (!config.destination || !config.destination.startsWith('/')) throw new BackupConfigError('destination must be an absolute path');
  if (config.destination.startsWith(`${homedir()}/.config`)) throw new BackupConfigError('destination must not be inside ~/.config');
  return config;
}

export async function loadConfig(path = process.env.NUVRION_BACKUP_CONFIG || DEFAULT_CONFIG_PATH) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { throw new BackupConfigError(`no configuration at ${path}; see docs/backups.md`); }
  return normaliseConfig(JSON.parse(text));
}

export const sshArguments = config => ['-i', config.identityFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15'];
export const sshCommand = config => ['ssh', ...sshArguments(config)].join(' ');
