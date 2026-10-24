import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guards the supply-chain settings themselves: if someone loosens a pin, these fail before the change reaches a build.
const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const containerBase = read('Containerfile.base');
const workflow = read('.github/workflows/ci.yml');

test('every base image is pinned by digest, so a moved tag cannot change what is built', () => {
  const stages = [...containerBase.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+\S+)?$/gm)].map(m => m[1]);
  assert.equal(stages.length, 2, 'a build stage and a runtime stage');
  for (const image of stages) assert.match(image, /^node:[0-9a-z.-]+@sha256:[0-9a-f]{64}$/, `${image} must be pinned to a digest`);
});

test('the image that ships is the slim one, without a package manager or a compiler', () => {
  const runtime = containerBase.slice(containerBase.lastIndexOf('\nFROM '));
  assert.match(runtime, /^FROM node:[0-9.]+-bookworm-slim@sha256:/m);
  assert.match(runtime, /rm -rf [^\n]*node_modules\/npm\b/);
  assert.match(runtime, /COPY --from=build /);
  assert.doesNotMatch(runtime, /npm (ci|install)/);
  // the only package change allowed in the runtime stage: the fixed version of one package, nothing else upgraded
  const aptCommands = runtime.match(/apt-get [^\n]*/g) ?? [];
  assert.deepEqual(aptCommands.length, 1);
  assert.match(aptCommands[0], /^apt-get update -qq && apt-get install -y --no-install-recommends --only-upgrade perl-base && rm -rf \/var\/lib\/apt\/lists\/\*$/);
  assert.doesNotMatch(runtime, /apt-get (upgrade|dist-upgrade)/);
});

test('the release version lives in the VERSION file, and CI builds the image with it', () => {
  const version = read('VERSION').trim();
  assert.match(version, /^0\.1\.\d+$/);
  const job = workflow.slice(workflow.indexOf('\n  image-scan:'), workflow.indexOf('\n  release-evidence:'));
  assert.match(job, /version="\$\(cat VERSION\)"/);
  assert.match(job, /--build-arg "RELEASE_VERSION=\$version"/);
});

test('the image that is scanned is the image that is kept, signed and shipped', () => {
  const scan = workflow.slice(workflow.indexOf('\n  image-scan:'), workflow.indexOf('\n  release-evidence:'));
  const evidence = workflow.slice(workflow.indexOf('\n  release-evidence:'), workflow.indexOf('\n  api-compatibility:'));
  assert.match(scan, /docker save localhost\/nuvrion:ci-image -o "image\/Nuvrion-Image-\$\{GITHUB_SHA\}\.tar"/);
  assert.match(scan, /--input \/in\/nuvrion-app\.tar/, 'Trivy scans a copy of the saved archive, not another build');
  assert.match(scan, /name: image-archive-\$\{\{ github\.sha \}\}/);
  assert.match(evidence, /release\/Nuvrion-Image-\*\.tar/, 'the image archive is a subject of the provenance attestation');
  assert.match(evidence, /sbom-path: release\/image-sbom\.cdx\.json/, 'the image SBOM is attested for the image archive');
});

test('container builds install exactly the locked dependencies, with the lockfile in the build context', () => {
  assert.match(containerBase, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.match(containerBase, /^RUN npm ci --omit=dev$/m);
  assert.doesNotMatch(containerBase, /npm install/);
});

test('every CI action is pinned to a full commit, and service images to a digest', () => {
  const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map(m => m[1]);
  assert.ok(uses.length >= 3);
  for (const reference of uses) assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must be pinned to a commit`);
  const images = [...workflow.matchAll(/^\s*image:\s*(\S+)/gm)].map(m => m[1]);
  assert.ok(images.length >= 1);
  for (const image of images) assert.match(image, /@sha256:[0-9a-f]{64}$/, `${image} must be pinned to a digest`);
});

test('CI installs from the lockfile and never regenerates it', () => {
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflow, /npm install/);
  assert.doesNotMatch(workflow, /--no-package-lock/);
});

test('CI runs the SBOM, provenance and vulnerability checks, and keeps their output', () => {
  for (const expected of ['generate-sbom.js create', 'generate-sbom.js verify', 'create-build-provenance.js create', 'create-build-provenance.js verify', 'npm audit --omit=dev --audit-level=high', 'upload-artifact']) {
    assert.ok(workflow.includes(expected), `${expected} is missing from the workflow`);
  }
});

test('CI checks every API description change for breaking changes against the previous commit', () => {
  assert.match(workflow, /check-api-compat\.js/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /contracts\/messages\/\*\.json/, 'message schemas are checked too');
});

test('the image scan runs a scanner pinned by digest, blocks on the policy, and keeps its report', () => {
  const job = workflow.slice(workflow.indexOf('\n  image-scan:'), workflow.indexOf('\n  release-evidence:'));
  assert.match(job, /TRIVY_IMAGE: \S+@sha256:[0-9a-f]{64}/);
  assert.match(job, /docker build -f Containerfile\.base/);
  assert.match(job, /node tools\/evaluate-image-scan\.js evidence\/image-scan\.json --exceptions deploy\/image-scan-exceptions\.json/);
  assert.match(job, /name: image-scan-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(job, /runs-on: ubuntu-24\.04-arm/, 'scanned on production architecture');
});

test('signing is confined to one job that runs only for main after every check passed, and no other job may write attestations or mint tokens', () => {
  const start = workflow.indexOf('\n  release-evidence:'), end = workflow.indexOf('\n  api-compatibility:');
  const job = workflow.slice(start, end), rest = workflow.slice(0, start) + workflow.slice(end);
  assert.match(job, /needs: \[checks, supply-chain, image-scan, agent-build, static-analysis\]/);
  assert.match(job, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(job, /id-token: write/);
  assert.match(job, /attestations: write/);
  assert.match(job, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(job, /actions\/attest-sbom@[0-9a-f]{40}/);
  assert.doesNotMatch(rest, /id-token|attestations: write/);
});

test('the agent is packaged in CI from its own locked toolchain, smoke-tested, and signed with the release (never by its own job)', () => {
  const start = workflow.indexOf('\n  agent-build:'), end = workflow.indexOf('\n  release-evidence:');
  const job = workflow.slice(start, end);
  assert.ok(start > 0 && end > start, 'there is an agent-build job');
  assert.match(job, /working-directory: tools\/agent-build\n\s+run: npm ci --ignore-scripts/, 'the packager is installed from tools/agent-build/package-lock.json');
  assert.match(job, /node tools\/build-workstation-agent\.js --out agent-build --source-revision/);
  assert.match(job, /--target node18-linux-x64 --smoke/, 'the same source is run through --self-check');
  assert.doesNotMatch(job, /id-token|attestations: write|attest-/, 'only release-evidence signs');
  const evidence = workflow.slice(end, workflow.indexOf('\n  api-compatibility:'));
  assert.match(evidence, /name: agent-build-\$\{\{ github\.sha \}\}/, 'release-evidence takes this commit\'s executable');
  assert.match(evidence, /release\/nuvrion-workstation-agent-\*\.exe/, 'and attests it');
  const lock = JSON.parse(read('tools/agent-build/package-lock.json')), manifest = JSON.parse(read('tools/agent-build/package.json'));
  assert.match(manifest.dependencies['@yao-pkg/pkg'], /^\d+\.\d+\.\d+$/, 'the packager version is exact, not a range');
  assert.equal(lock.packages['node_modules/@yao-pkg/pkg'].version, manifest.dependencies['@yao-pkg/pkg']);
});

test('static analysis runs from its own locked toolchain, fails on a finding outside the reviewed baseline, and gates the signing job', () => {
  const start = workflow.indexOf('\n  static-analysis:'), end = workflow.indexOf('\n  agent-build:');
  assert.ok(start > 0 && end > start, 'there is a static-analysis job');
  const job = workflow.slice(start, end);
  assert.match(job, /working-directory: tools\/static-analysis\n\s+run: npm ci --ignore-scripts/, 'the analyser is installed from tools/static-analysis/package-lock.json');
  assert.match(job, /eslint\.js --config tools\/static-analysis\/eslint\.config\.js --suppressions-location tools\/static-analysis\/eslint-suppressions\.json/);
  assert.doesNotMatch(job, /--suppress-all|--prune-suppressions|--max-warnings|\|\| true|continue-on-error/, 'the gate can neither rewrite its baseline nor be made to pass');
  assert.doesNotMatch(job, /id-token|attestations: write|attest-/, 'only release-evidence signs');
  const manifest = JSON.parse(read('tools/static-analysis/package.json')), lock = JSON.parse(read('tools/static-analysis/package-lock.json'));
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
    assert.equal(lock.packages[`node_modules/${name}`].version, version, `${name} is locked at that version`);
  }
});

test('the licence review runs in the supply-chain job, covers every lockfile, and keeps its report with the evidence', () => {
  const start = workflow.indexOf('\n  supply-chain:'), end = workflow.indexOf('\n  image-scan:');
  const job = workflow.slice(start, end);
  assert.match(job, /name: Licence review\n\s+run: node tools\/evaluate-licenses\.js --out evidence\/license-report\.json/);
  assert.ok(job.indexOf('Licence review') < job.indexOf('Keep the evidence'), 'the report is written before the evidence is kept');
  const tool = read('tools/evaluate-licenses.js');
  for (const lockfile of ['tools/agent-build', 'tools/static-analysis']) assert.ok(tool.includes(`'${lockfile}'`), `${lockfile} is reviewed too`);
  const policy = JSON.parse(read('deploy/license-policy.json'));
  assert.equal(policy.format, 'nuvrion-license-policy/1');
  assert.ok(!policy.allowed.some(id => /GPL|SSPL|BUSL|NC/i.test(id)), 'no copyleft or non-commercial licence is on the allow list');
});

// A test that hangs used to hold the whole job until its 15-minute limit cancelled it, and a cancelled job prints no summary, so the failure said nothing. With a limit per test, a stuck test fails
// by itself (reported as "test timed out"), the run goes on and the summary is printed. The slowest legitimate test in CI takes about 26 seconds; the limit is several times that, and well below the job's.
test('the test command gives every test a time limit, which CI inherits by running npm test', () => {
  const script = JSON.parse(read('package.json')).scripts.test;
  const limit = Number(/--test-timeout=(\d+)/.exec(script)?.[1]);
  assert.ok(Number.isFinite(limit), `npm test has no --test-timeout: ${script}`);
  assert.ok(limit >= 60_000, 'a slow shared runner must not trip it (the slowest test takes about 26 s)');
  assert.ok(limit <= 300_000, 'a stuck test must fail long before the job is cancelled');
  const jobLimitMinutes = Number(/checks:\n(?:.*\n)*?\s+timeout-minutes: (\d+)/.exec(workflow)?.[1]);
  assert.ok(limit < jobLimitMinutes * 60_000 / 3, 'the limit leaves room for several stuck tests before the job limit');
  assert.match(workflow, /run: npm test\n/, 'CI runs the tests through npm test, so it gets the limit');
});
