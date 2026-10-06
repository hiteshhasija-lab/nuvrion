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
