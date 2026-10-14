import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTextForSecrets, evaluateSecretScan, ALLOW_MARKER } from '../src/secret-scanner.js';

// The sample secrets are assembled from pieces so this file does not itself look like a leak to the scanner.
const privateKey = '-----BEGIN ' + 'PRIVATE KEY-----';
const awsKey = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const dbUrl = 'postgres' + '://nuvrion:s3cr3t@db.example:5432/nuvrion';
const assigned = 'pass' + 'word = "correct-horse-battery"';
const rules = text => scanTextForSecrets(text, { path: 'x.js' }).map(f => f.ruleId);

test('each kind of secret is detected', () => {
  assert.deepEqual(rules(privateKey), ['private-key']);
  assert.deepEqual(rules(`const k = '${awsKey}';`), ['aws-access-key']);
  assert.deepEqual(rules(`DATABASE_URL=${dbUrl}`), ['credential-url']);
  assert.deepEqual(rules(assigned), ['assigned-secret']);
  assert.deepEqual(rules('tok' + "en = 'abcdefghijklmnop'"), ['assigned-secret']);
});

test('findings carry the path and the line number', () => {
  const findings = scanTextForSecrets(`line one\nline two\n${assigned}\n`, { path: 'src/a.js' });
  assert.deepEqual(findings, [{ ruleId: 'assigned-secret', path: 'src/a.js', line: 3 }]);
});

test('ordinary code and short or empty values are not reported', () => {
  for (const text of ['const x = 1;', "const password = '';", "const password = 'short';", 'const url = "https://example.com/path";', 'function secretHandler() { return token; }', "postgres://localhost/db"]) {
    assert.deepEqual(rules(text), [], text);
  }
});

test('a line with the allow marker is skipped, and only that line', () => {
  const text = `${assigned} // ${ALLOW_MARKER} (fake)\n${assigned}`;
  assert.deepEqual(scanTextForSecrets(text, { path: 'a' }).map(f => f.line), [2]);
});

test('files are scanned together and the paths are kept apart', () => {
  const findings = evaluateSecretScan([{ path: 'a.js', text: assigned }, { path: 'b.js', text: 'const ok = true;' }, { path: 'c.js', text: privateKey }]);
  assert.deepEqual(findings.map(f => `${f.path}:${f.ruleId}`), ['a.js:assigned-secret', 'c.js:private-key']);
});

test('windows line endings are handled', () => {
  assert.equal(scanTextForSecrets(`ok\r\n${assigned}\r\n`, { path: 'a' })[0].line, 2);
});

// The command-line scan walks the repository's directories. Packages installed from a lockfile (tools/agent-build/node_modules, for the packager)
// are third-party code covered by the lockfile and the dependency audit, not repository source, so they are not read.
test('the repository scan reads source files but not installed packages', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-scan-'));
  try {
    mkdirSync(join(dir, 'tools/agent-build/node_modules/some-package'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}\n');
    writeFileSync(join(dir, 'tools/agent-build/node_modules/some-package/package.json'), '{ "token": "' + 'x'.repeat(24) + '" }\n');
    const script = new URL('../../../tools/scan-repository-secrets.js', import.meta.url).pathname;
    const clean = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(JSON.parse(clean.stdout).findingCount, 0);
    writeFileSync(join(dir, 'tools/real-source.js'), 'const settings = { token: "' + 'y'.repeat(24) + '" };\n');
    const dirty = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(dirty.status, 1, 'a real source file is still scanned');
    assert.match(dirty.stderr, /tools\/real-source\.js/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
