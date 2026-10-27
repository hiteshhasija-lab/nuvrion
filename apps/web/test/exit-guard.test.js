import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The guard in apps/web/test-support/exit-guard.js ends a test file's process that is still alive after its tests ended, says what was open, and leaves the verdict of the tests alone.
const guard = new URL('../test-support/exit-guard.js', import.meta.url).href;
function runFile(body, seconds = 40) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvrion-exit-guard-'));
  try {
    writeFileSync(join(dir, 'fixture.test.js'), `import { describe, test, after } from 'node:test';\nimport { exitWhenIdle } from '${guard}';\n${body}`);
    const started = Date.now(), result = spawnSync(process.execPath, ['--test', join(dir, 'fixture.test.js')], { encoding: 'utf8', timeout: seconds * 1000, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')) });   // a test run inside a test run is refused unless this is removed
    return { ...result, seconds: (Date.now() - started) / 1000, output: `${result.stdout}${result.stderr}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a process kept alive by a leaked handle is ended after the guard time, with what was open, and a failing test is still a failure', () => {
  const run = runFile(`describe('a file that would never end', () => {\n  after(() => { exitWhenIdle(1); });\n  test('passes', () => {});\n  test('fails', () => { throw new Error('deliberate'); });\n  setInterval(() => {}, 1000);\n});`);
  assert.equal(run.signal, null, 'it was not killed by the timeout: the guard ended it');
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /still alive 1 s after its tests ended; open resources \{[^}]*"Timeout":1/);
  assert.match(run.output, /✖ fails/);
  assert.match(run.output, /ℹ fail 1/);
  assert.ok(run.seconds < 30, `it took ${run.seconds} s`);
});

test('a process that ends by itself is not delayed and the guard says nothing', () => {
  const run = runFile(`describe('a file that ends', () => {\n  after(() => { exitWhenIdle(30); });\n  test('passes', () => {});\n});`);
  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /still alive/);
  assert.ok(run.seconds < 15, `a 30 s guard must not hold a process that ends by itself (${run.seconds} s)`);
});
