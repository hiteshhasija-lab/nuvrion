import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class AgentSettingsError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 422; }
}

// The address agents use for this platform (their apiUrl), as an origin. A release names its executable by an address inside the signed
// manifest, and an agent only trusts the origin it already talks to, so builds the platform registers by itself need to use this address.
// Kept in a small file next to the upgrade data, written atomically.
export function normalizeOrigin(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw new AgentSettingsError('NUV_AGENT_UPGRADE_URL_INVALID', 'Enter the address agents use for the platform, such as https://nuvrion.example.'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new AgentSettingsError('NUV_AGENT_UPGRADE_URL_INVALID', 'The address agents use must be an https:// address with no path.');
  }
  return url.origin;
}

export class AgentPlatformSettings {
  constructor({ file }) { this.file = file; }

  async get() {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'));
      return { publicBaseUrl: stored.publicBaseUrl ? normalizeOrigin(stored.publicBaseUrl) : null, updatedAt: stored.updatedAt ?? null, updatedBy: stored.updatedBy ?? null };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof AgentSettingsError) return { publicBaseUrl: null, updatedAt: null, updatedBy: null };
      throw error;
    }
  }

  async setPublicBaseUrl(value, { by = null } = {}) {
    const publicBaseUrl = normalizeOrigin(value), record = { publicBaseUrl, updatedAt: new Date().toISOString(), updatedBy: by };
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o644 });
    await rename(temporary, this.file);
    return record;
  }
}
