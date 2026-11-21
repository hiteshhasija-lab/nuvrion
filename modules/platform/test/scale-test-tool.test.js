import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The scale test builds a large synthetic estate and drops a database, so its refusals are what keep it away from anything real. These tests run the tool as an operator would
// and check that it stops before doing any work, without a PostgreSQL.
const run = promisify(execFile);
const tool = fileURLToPath(new URL('../../../tools/run-reference-scale.js', import.meta.url));
const attempt = async (env, args) => {
  const directory = await mkdtemp(join(tmpdir(), 'nuvrion-scale-test-'));
  try {
    const output = join(directory, 'evidence.json');
    const result = await run(process.execPath, [tool, ...args.map(arg => arg ?? output)], { env: { PATH: process.env.PATH, ...env }, timeout: 30000 }).then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    result.wroteEvidence = await stat(output).then(() => true, () => false);
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
};

test('the scale test refuses to run without the synthetic-only acknowledgement', async () => {
  const result = await attempt({ NUVRION_TEST_DATABASE_URL: 'postgres://u@127.0.0.1/postgres' }, [null]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Usage: NUVRION_QUALIFICATION_ACK=synthetic-only/);
  assert.equal(result.wroteEvidence, false);
});

test('the scale test refuses a database that is not on this machine, before connecting to anything', async () => {
  for (const host of ['db.example.com', '10.0.0.100', 'nuvrion.lab.sps']) {
    const result = await attempt({ NUVRION_QUALIFICATION_ACK: 'synthetic-only', NUVRION_TEST_DATABASE_URL: `postgres://u@${host}/postgres` }, [null]);
    assert.notEqual(result.code, 0, host);
    assert.match(result.stderr, /Refusing to run against/, host);
    assert.equal(result.wroteEvidence, false, host);
  }
});

test('the scale test needs an evidence file name', async () => {
  const result = await attempt({ NUVRION_QUALIFICATION_ACK: 'synthetic-only', NUVRION_TEST_DATABASE_URL: 'postgres://u@127.0.0.1/postgres' }, []);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Usage:/);
});
