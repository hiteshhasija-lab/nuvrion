import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

// `node --test` with no arguments runs every file whose name looks like a test (`*-test.js`, `*_test.js`, `test-*.js`, `test.js`, any `*.test.js`) wherever it is, and every script
// under a directory called `test`. A tool named like a test is therefore run as one, with no arguments, and fails the build: tools/run-scale-test.js did exactly that on its first push.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const looksLikeATest = name => /(^|[-_.])test\.(c|m)?js$/.test(name) || /^test-.*\.(c|m)?js$/.test(name);
async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.nuvrion') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path); else yield path;
  }
}

test('no script outside a test directory is named like a test, because node --test would run it', async () => {
  const offenders = [];
  for await (const path of walk(root)) {
    const name = path.split(sep).at(-1), where = relative(root, path);
    if (!/\.(c|m)?js$/.test(name) || !looksLikeATest(name)) continue;
    const inTestDirectory = where.split(sep).some(part => part === 'test' || part === 'test-support');   // test-support holds helpers that only export, so running one does nothing
    const isTestFile = /\.test\.(c|m)?js$/.test(name);
    if (!inTestDirectory && !isTestFile) offenders.push(where);
  }
  assert.deepEqual(offenders, [], `rename these so that node --test does not run them: ${offenders.join(', ')}`);
});
