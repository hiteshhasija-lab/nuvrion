// Static analysis of the Nuvrion source: ESLint with the security rules, from a pinned toolchain (tools/static-analysis/package-lock.json).
// It runs in CI on every push and fails the build on a finding. A finding is fixed, or is accepted in the source with a reason
// (`// eslint-disable-next-line <rule> -- <why this is safe>`; an unused directive is an error), or it is one of the findings recorded when the gate was
// introduced in eslint-suppressions.json, a baseline that can only shrink (see docs/security-analysis.md).
import security from 'eslint-plugin-security';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

// The timer functions must be known as globals for no-implied-eval to recognise setTimeout("code", ...) as the global one.
const timers = { setTimeout: 'readonly', setInterval: 'readonly', setImmediate: 'readonly' };
const tests = ['**/test/**', '**/*.test.js', '**/*.test.cjs', '**/test-support/**', 'apps/web/test/**'];

export default [
  { ignores: ['**/node_modules/**', 'tools/static-analysis/**', 'tools/agent-build/**', 'apps/web/vendor/**', '.nuvrion/**', ...tests] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: timers },
    linterOptions: { reportUnusedDisableDirectives: 'error' }
  },
  { files: ['**/*.cjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: timers }, linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    plugins: { security, 'no-unsanitized': noUnsanitized },
    rules: {
      // injection and code execution
      'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error', 'no-script-url': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      'security/detect-non-literal-require': 'error',
      // patterns, timing, randomness, buffers
      'security/detect-non-literal-regexp': 'error',
      'security/detect-unsafe-regex': 'error',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-bidi-characters': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-no-csrf-before-method-override': 'error'
      // detect-object-injection is not enabled: it flags every bracket access with a variable and its false positives bury the real findings
    }
  },
  {
    // File paths built from variables: this rule fires on every fs call whose path is not a literal, which is nearly all of them in a program that has
    // configuration, so it is on only where URL or request data can reach a path (the request handler and the modules it hands uploads and ids to). In the
    // rest (tools, the agent, stores) paths come from configuration, constants and generated identifiers, and were reviewed as such.
    files: ['apps/api/src/server.js', 'modules/platform/src/platform-upgrade-service.js', 'modules/agents/src/agent-artifact-store.js',
      'modules/agents/src/agent-build-importer.js', 'modules/agents/src/agent-platform-settings.js'],
    plugins: { security },
    rules: { 'security/detect-non-literal-fs-filename': 'error' }
  },
  {
    // the console builds HTML from strings: every interpolated value must go through esc() (or be a number or a known-safe helper's result)
    files: ['apps/web/**/*.js'],
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      'no-unsanitized/method': ['error', { escape: { methods: ['esc'] } }],
      'no-unsanitized/property': ['error', { escape: { methods: ['esc'] } }]
    }
  }
];
