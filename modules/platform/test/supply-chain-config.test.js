import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Guards the supply-chain settings themselves: if someone loosens a pin, these fail before the change reaches a build.
const read = path => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const containerBase = read('Containerfile.base');
const workflow = read('.github/workflows/ci.yml');

test('the base image is pinned by digest, so a moved tag cannot change what is built', () => {
  assert.match(containerBase, /^FROM node:[0-9a-z.-]+@sha256:[0-9a-f]{64}$/m);
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
});
