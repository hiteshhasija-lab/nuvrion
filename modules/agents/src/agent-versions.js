// Agent versions are compared the way the agent itself compares them (apps/workstation-agent/src/self-upgrade.cjs): major.minor.patch only,
// so a build that differs only in its suffix is the same version and nothing downgrades.
export function parseAgentVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isNewerAgentVersion(candidate, current) {
  const a = parseAgentVersion(candidate), b = parseAgentVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
