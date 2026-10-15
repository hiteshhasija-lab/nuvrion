import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// The static analysis gate (tools/static-analysis) is only worth having while it detects what it claims to. These tests run its real configuration against
// small sources, check that the reviewed baseline is sound, and so would fail if the rules were loosened or the baseline were padded.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const toolchain = join(root, 'tools/static-analysis');
const installed = existsSync(join(toolchain, 'node_modules/eslint/package.json'));
const options = { skip: installed ? false : 'the analysis toolchain is not installed (npm ci in tools/static-analysis)' };

async function lint(code, filePath) {
  const { ESLint } = await import(pathToFileURL(join(toolchain, 'node_modules/eslint/lib/api.js')).href);
  const eslint = new ESLint({ cwd: root, overrideConfigFile: join(toolchain, 'eslint.config.js'), ignore: false });
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.map(message => message.ruleId);
}

test('code execution and injection patterns are errors anywhere in the source', options, async () => {
  const cases = [
    ['exec(`ls ${input}`);', 'security/detect-child-process', "import { exec } from 'node:child_process';\n"],
    ['eval(input);', 'no-eval', ''],
    ['new Function(input);', 'no-new-func', ''],
    ['setTimeout("doSomething()", 10);', 'no-implied-eval', ''],
    ['const re = new RegExp(input);', 'security/detect-non-literal-regexp', ''],
    ['if (token === expected) return 1;', 'security/detect-possible-timing-attacks', '']
  ];
  for (const [body, rule, prelude] of cases) {
    const rules = await lint(`${prelude}export function f(input, token, expected) { ${body} }\n`, 'modules/probe.js');
    assert.ok(rules.includes(rule), `${rule} did not fire for: ${body}`);
  }
});

test('a path built from a variable is an error where URL or request data can reach it, and is not flagged in tools', options, async () => {
  const code = "import { readFileSync } from 'node:fs';\nexport const read = name => readFileSync(name);\n";
  assert.ok((await lint(code, 'apps/api/src/server.js')).includes('security/detect-non-literal-fs-filename'));
  assert.ok((await lint(code, 'modules/agents/src/agent-artifact-store.js')).includes('security/detect-non-literal-fs-filename'));
  assert.ok(!(await lint(code, 'tools/some-tool.js')).includes('security/detect-non-literal-fs-filename'));
});

test('in the console, an interpolated value in HTML must go through esc()', options, async () => {
  const unescaped = await lint('export function show(el, user) { el.innerHTML = `<b>${user.name}</b>`; }\n', 'apps/web/probe.js');
  assert.ok(unescaped.includes('no-unsanitized/property'), 'an unescaped interpolation is an error');
  const escaped = await lint('export function show(el, user) { el.innerHTML = `<b>${esc(user.name)}</b>`; }\n', 'apps/web/probe.js');
  assert.ok(!escaped.includes('no-unsanitized/property'), 'esc() is the accepted way');
  const insert = await lint('export function show(el, user) { el.insertAdjacentHTML("beforeend", `<b>${user.name}</b>`); }\n', 'apps/web/probe.js');
  assert.ok(insert.includes('no-unsanitized/method'));
});

test('test code and the toolchain itself are not analysed, and source is', options, async () => {
  const { ESLint } = await import(pathToFileURL(join(toolchain, 'node_modules/eslint/lib/api.js')).href);
  const eslint = new ESLint({ cwd: root, overrideConfigFile: join(toolchain, 'eslint.config.js') });
  for (const ignored of ['modules/platform/test/probe.test.js', 'apps/web/test/e2e/probe.js', 'database/test-support/probe.js', 'tools/static-analysis/probe.js', 'tools/agent-build/probe.js']) {
    assert.equal(await eslint.isPathIgnored(join(root, ignored)), true, `${ignored} should be ignored`);
  }
  for (const analysed of ['apps/api/src/server.js', 'modules/agents/src/agent-auto-upgrade.js', 'providers/vmware-settings.js', 'tools/build-workstation-agent.js', 'apps/web/agent-fleet.js']) {
    assert.equal(await eslint.isPathIgnored(join(root, analysed)), false, `${analysed} should be analysed`);
  }
});

test('the reviewed baseline is well formed: known rules, positive counts, existing files, and nothing that is an error class', options, () => {
  const baseline = JSON.parse(readFileSync(join(toolchain, 'eslint-suppressions.json'), 'utf8'));
  const allowedInBaseline = new Set(['security/detect-non-literal-fs-filename', 'security/detect-unsafe-regex', 'security/detect-non-literal-regexp',
    'security/detect-possible-timing-attacks', 'no-unsanitized/property', 'no-unsanitized/method', 'no-script-url']);
  assert.ok(Object.keys(baseline).length > 0);
  for (const [file, rules] of Object.entries(baseline)) {
    assert.ok(existsSync(join(root, file)), `${file} no longer exists: prune the baseline`);
    for (const [rule, entry] of Object.entries(rules)) {
      assert.ok(allowedInBaseline.has(rule), `${rule} in ${file} is a class that must not be baselined (execution and injection rules are fixed, not suppressed)`);
      assert.ok(Number.isInteger(entry.count) && entry.count > 0, `${file} ${rule} count`);
    }
  }
});
