import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// The host script publishes an agent executable from an applied release into the artifact directory and leaves a small record in the
// intake directory. This registers a signed release for each such record, once, so agents are offered the build without anyone uploading it.
//
//   waiting    the address agents use for the platform is not known yet; the records stay where they are
//   imported   a release was registered, or was already registered for this exact build
//   rejected   the record or the file is not what it claims, or the version exists with different bytes; moved to rejected/ with the reason
export async function importAgentBuilds({ intakeDirectory, store, upgrades, settings, record = async () => {}, log = () => {} }) {
  const result = { imported: [], alreadyKnown: [], rejected: [], waiting: 0 };
  let names;
  try { names = (await readdir(intakeDirectory)).filter(name => name.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  if (!names.length) return result;
  const { publicBaseUrl } = await settings.get();
  if (!publicBaseUrl) { result.waiting = names.length; return result; }

  const move = async (name, folder, extra = null) => {
    await mkdir(join(intakeDirectory, folder), { recursive: true });
    await rename(join(intakeDirectory, name), join(intakeDirectory, folder, name));
    if (extra) await writeFile(join(intakeDirectory, folder, `${name}.reason.txt`), `${extra}\n`);
  };
  for (const name of names) {
    try {
      let intake;
      try { intake = JSON.parse(await readFile(join(intakeDirectory, name), 'utf8')); } catch { throw Object.assign(new Error('The record is not valid JSON.'), { reject: true }); }
      if (intake?.format !== 'nuvrion-agent-intake/1' || !VERSION.test(String(intake.version)) || !SHA256.test(String(intake.sha256)) || !Number.isSafeInteger(intake.sizeBytes) || intake.sizeBytes <= 0
        || name !== `${intake.sha256}.json`) throw Object.assign(new Error('The record is not a well-formed agent build record.'), { reject: true });
      try { await store.verify(intake.sha256, { sizeBytes: intake.sizeBytes }); } catch (error) { throw Object.assign(new Error(error.message), { reject: true }); }
      const existing = await upgrades.releaseByVersion(intake.version);
      if (existing) {
        if (existing.manifest.sha256 === intake.sha256) { await move(name, 'imported'); result.alreadyKnown.push(intake.version); continue; }
        throw Object.assign(new Error(`Version ${intake.version} is already registered with a different executable. Give the new build its own version.`), { reject: true });
      }
      const release = await upgrades.registerRelease({ version: intake.version, artifactUrl: `${publicBaseUrl}/api/v1/agent-upgrades/artifacts/${intake.sha256}`, sha256: intake.sha256, sizeBytes: intake.sizeBytes });
      await move(name, 'imported');
      result.imported.push({ version: intake.version, sha256: intake.sha256, releaseId: release.manifest.releaseId, release: intake.release ?? null });
      await record({ outcome: 'succeeded', version: intake.version, sha256: intake.sha256, releaseId: release.manifest.releaseId, sizeBytes: intake.sizeBytes, origin: publicBaseUrl, fromRelease: intake.release ?? null });
    } catch (error) {
      if (error.reject) {
        result.rejected.push({ file: name, reason: error.message });
        await move(name, 'rejected', error.message).catch(() => {});
        await record({ outcome: 'failed', file: name, reason: error.message });
        log('agent.build_import.rejected', { file: name, reason: error.message });
      } else {
        // Not the record's fault (the database was unavailable, say): leave it where it is and try again on the next run.
        log('agent.build_import.failed', { file: name, message: String(error.message).slice(0, 200) });
      }
    }
  }
  return result;
}
