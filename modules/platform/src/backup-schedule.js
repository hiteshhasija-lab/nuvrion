// The launchd job that runs `node tools/backup.js pull` on the owner’s Mac every hour (and at login), so backups and release evidence are collected without
// anyone remembering to. Generated rather than hand-edited so the paths are always the real ones.
const escapeXml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const LAUNCH_LABEL = 'com.nuvrion.backup-pull';

export function launchAgentPlist({ node, script, workingDirectory, path, log, intervalSeconds = 3600 }) {
  for (const [name, value] of Object.entries({ node, script, workingDirectory, log })) if (!String(value).startsWith('/')) throw new Error(`${name} must be an absolute path`);
  if (!(intervalSeconds >= 300)) throw new Error('the interval must be at least 5 minutes');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(node)}</string><string>${escapeXml(script)}</string><string>pull</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${escapeXml(path)}</string></dict>
  <key>StartInterval</key><integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
</dict>
</plist>
`;
}
