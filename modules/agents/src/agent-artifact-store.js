import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;

export class AgentArtifactError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status; }
}

// Holds Workstation agent executables, one file per SHA-256, in the directory the artifact download route serves from.
// An upload is streamed to a temporary file in the same directory, counted and hashed as it arrives, checked, and only then
// renamed into place, so the download route can never serve a partial or unchecked file.
export class AgentArtifactStore {
  constructor({ directory, maxBytes = 200 * 1024 * 1024 }) {
    this.directory = directory;
    this.maxBytes = maxBytes;
  }

  pathFor(sha256) {
    if (!SHA256.test(String(sha256))) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_INVALID', 'The checksum is not a SHA-256.');
    return join(this.directory, sha256);
  }

  async has(sha256) {
    try { return SHA256.test(String(sha256)) && (await stat(this.pathFor(sha256))).isFile(); } catch { return false; }
  }

  // Confirms that a file already in the directory is what a record says it is: present, the size, the digest, and a Windows executable.
  async verify(sha256, { sizeBytes }) {
    let size;
    try { size = (await stat(this.pathFor(sha256))).size; } catch (error) { if (error instanceof AgentArtifactError) throw error; throw new AgentArtifactError('NUV_AGENT_ARTIFACT_MISSING', 'The executable is not on the platform.', 404); }
    if (size !== sizeBytes) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_SIZE_MISMATCH', `The stored executable is ${size} bytes, not ${sizeBytes}.`);
    const hash = createHash('sha256');
    let header = Buffer.alloc(0);
    for await (const chunk of createReadStream(this.pathFor(sha256))) {
      if (header.length < 2) header = Buffer.concat([header, chunk]).subarray(0, 2);
      hash.update(chunk);
    }
    if (hash.digest('hex') !== sha256) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_CHECKSUM_MISMATCH', 'The stored executable does not match its checksum.');
    if (header[0] !== 0x4d || header[1] !== 0x5a) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_NOT_EXECUTABLE', 'The stored file is not a Windows executable.');
    return true;
  }

  async store(stream, { expectedSha256 = null, declaredLength = null } = {}) {
    const expected = expectedSha256 ? String(expectedSha256).trim().toLowerCase() : null;
    if (expected && !SHA256.test(expected)) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_INVALID', 'The checksum is not a SHA-256.');
    if (Number(declaredLength) > this.maxBytes) throw tooLarge(this.maxBytes);
    await mkdir(this.directory, { recursive: true, mode: 0o755 });
    const temporary = join(this.directory, `.upload-${randomUUID()}`);
    const output = createWriteStream(temporary, { flags: 'wx', mode: 0o644 });
    const hash = createHash('sha256');
    let bytes = 0, header = Buffer.alloc(0), writeError = null;
    output.once('error', error => { writeError = error; });
    try {
      for await (const chunk of stream) {
        if (writeError) throw writeError;
        bytes += chunk.length;
        if (bytes > this.maxBytes) throw tooLarge(this.maxBytes);
        if (header.length < 2) header = Buffer.concat([header, chunk]).subarray(0, 2);
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise(resolve => { output.once('drain', resolve); output.once('error', resolve); });
      }
      if (writeError) throw writeError;
      await new Promise((resolve, reject) => output.end(error => (error ? reject(error) : resolve())));
      if (!bytes) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_EMPTY', 'The uploaded file is empty.');
      // Every Windows executable starts with "MZ"; this refuses an archive, a script or a web page chosen by mistake.
      if (header[0] !== 0x4d || header[1] !== 0x5a) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_NOT_EXECUTABLE', 'The file is not a Windows executable.');
      const sha256 = hash.digest('hex');
      if (expected && expected !== sha256) throw new AgentArtifactError('NUV_AGENT_ARTIFACT_CHECKSUM_MISMATCH', 'The checksum does not match the uploaded file. It was discarded.');
      await rename(temporary, this.pathFor(sha256));
      return { sha256, sizeBytes: bytes };
    } catch (error) {
      // The file may still be opening: remove it only once the stream has closed, or it can reappear after the removal.
      await new Promise(resolve => { if (output.closed) resolve(); else { output.once('close', resolve); output.destroy(); } });
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}

function tooLarge(maxBytes) {
  return new AgentArtifactError('NUV_AGENT_ARTIFACT_TOO_LARGE', `The file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, 413);
}
