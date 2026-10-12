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
  assert.doesNotMatch(runtime, /apt-get|npm (ci|install)/);
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
  assert.match(job, /needs: \[checks, supply-chain, image-scan\]/);
  assert.match(job, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(job, /id-token: write/);
  assert.match(job, /attestations: write/);
  assert.match(job, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(job, /actions\/attest-sbom@[0-9a-f]{40}/);
  assert.doesNotMatch(rest, /id-token|attestations: write/);
});
