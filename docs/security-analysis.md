# Static analysis and licence review

Two checks run in CI on every push and are part of the release evidence (`release-evidence` needs both): **static
analysis** of the Nuvrion source, and a **licence review** of every package that is installed. This page says what each
one does, how to run it on your own machine, how to change what it accepts, and what it does **not** tell you.

## Static analysis

**What runs.** ESLint 9 with two security plugins, from a toolchain of its own that is pinned by lockfile
(`tools/static-analysis/package.json`, `package-lock.json`; installed in CI with `npm ci --ignore-scripts`; none of it
ships). Configuration: `tools/static-analysis/eslint.config.js`.

| Rule family | Plugin | Looks for |
|---|---|---|
| `no-eval`, `no-implied-eval`, `no-new-func`, `no-script-url`, `detect-eval-with-expression` | ESLint / security | code built from strings |
| `detect-child-process`, `detect-non-literal-require` | security | commands and modules chosen at run time |
| `detect-non-literal-regexp`, `detect-unsafe-regex` | security | patterns built from data; patterns that can backtrack badly |
| `detect-possible-timing-attacks` | security | `===` on values named like secrets |
| `detect-non-literal-fs-filename` | security | file paths built from variables, **only** in the request handler and the modules uploads and ids reach |
| `no-unsanitized/property`, `no-unsanitized/method` | no-unsanitized | HTML built in the console without `esc()` |

`detect-object-injection` is deliberately off: it flags every `x[y]` and buries real findings.

**How it gates.** A finding fails the build. A finding that existed when the gate was introduced is recorded in
`tools/static-analysis/eslint-suppressions.json` (ESLint bulk suppressions: a count per file and rule). That makes the
baseline a *ratchet*: a file may have fewer of a rule's findings than recorded, never more, and a new file may have
none. CI refuses `--suppress-all`, `--prune-suppressions` and `continue-on-error`
(`modules/platform/test/supply-chain-config.test.js`), and a test refuses a baseline that contains the code-execution
and injection rules. A deliberate exception in the source is
`// eslint-disable-next-line <rule> -- <why this is safe>`; an unused or reason-less directive is an error.

**Run it locally.**

```bash
npm run static-analysis
```

The toolchain is installed once with `npm ci --ignore-scripts` inside `tools/static-analysis`.

**Reducing the baseline** (after fixing findings): run the command with `-- --prune-suppressions`, review the diff of
`eslint-suppressions.json`, and commit it. CI never does this by itself.

### What the first run found

314 raw findings. 163 were recorded as the baseline; the rest were fixed or were in test code (which is not analysed).
After the fixes below the baseline is **131**:

| Rule | Baseline | Where |
|---|---:|---|
| `no-unsanitized/property`, `/method` | 65 | `apps/web/app.js` (62), `apps/web/agent-fleet.js` (3): HTML strings the rule cannot prove are escaped; reviewed, see "The console" below |
| `detect-non-literal-fs-filename` | 31 | request handler, upgrade service, agent artifact store and importer, agent platform settings |
| `detect-unsafe-regex` | 29 | see below |
| `detect-possible-timing-attacks` | 3 | comparisons of non-secret strings whose names the rule dislikes |
| `detect-non-literal-regexp` | 2 | `agent-service.cjs` |
| `no-script-url` | 1 | `vmware-media.js`: the string `'javascript:'` in a filter that skips such links when listing datastore files; nothing is executed |

**A real finding, fixed: quadratic parsing of SOAP replies.** The ESXi and vCenter providers found XML elements with
patterns of the shape `<NAME…>[\s\S]*?</NAME>`. When the closing tag is missing the pattern is retried from every
opening tag and rescans the rest of the reply each time. Measured on this code before the change, for a reply made of
unclosed `<propSet>` tags:

| Reply size | Before | After |
|---:|---:|---:|
| 100 KB | 97 ms | 0.8 ms |
| 200 KB | 365 ms | 0.5 ms |
| 400 KB | 1 477 ms | 0.7 ms |
| 5 MB | minutes (extrapolated, 4× per doubling) | 8 ms |

The API runs on one thread, so a reply like that from an endpoint stalls every request. `providers/soap-xml.js` finds
the same elements in one linear scan; `providers/test/soap-xml.test.js` compares it with the original patterns on
generated and hostile replies, and the provider tests (against the fake ESXi and vCenter endpoints) pass unchanged.
Four files use it: `esxi-provider.js`, `vmware-settings.js`, `vmware-snapshots.js`, `vsphere-quickstats.js`.
That removed 20 `detect-unsafe-regex` and 10 `detect-non-literal-regexp` entries.

**Memory is bounded too.** Every read of a reply from a VMware endpoint goes through `providers/response-body.js`: the
five XML and HTML reads (ESXi, settings, snapshots, quick statistics, the datastore browser) and the JSON reads of the
vSphere and Workstation REST providers. A reply over 64 MB is refused, on its declared length or as the bytes arrive,
and the connection is released. It is refused rather than truncated, because a cut-off document would parse as
"missing" and the inventory would mark real machines as gone. The error is `NUV_PROVIDER_RESPONSE_TOO_LARGE` (not
retried). An oversized error body is not read at all: the failure is reported from the HTTP status, as before.

**The remaining `detect-unsafe-regex` entries** were read: they are anchored, bounded (`{0,500}`), or each scan
consumes a distinct run of input, so they are linear in practice; the rule flags nested optional groups as a pattern,
not as a measurement. They stay in the baseline until someone replaces them with something the rule can see through.

**The console (`no-unsanitized`), reviewed finding by finding.** The console builds HTML from strings, and the rule accepts
only values that pass through `esc()`. The 67 findings were each parsed (not read by eye: the source is long single
lines) and every interpolated value that does not go through `esc()` was listed, following the local helpers they call.
The result:

- **Fixed (defence in depth, no behaviour change):** identifiers and other server-supplied values were placed in
  attributes unescaped: `data-*="${x.id}"` for resources, connections, alerts, tasks, users and sessions (36 places), the
  device keys in `data-settings-*="${CSS.escape(...)}"` (9; `CSS.escape` is not HTML escaping and leaves a double quote in
  place, so a device id containing one would have ended the attribute), the operation names, an alert severity used as a CSS
  class, a controller unit number, and the keys, labels and ids in `settingsSelect` and `settingsCheck`. All of these are
  generated by the platform or are constants today, so none was exploitable as found; it is the next provider or agent that
  sends a hostile string that this closes.
- **Safe, left as they are (the 65 remaining findings):** numbers (counts, offsets, page sizes, chart coordinates, `toFixed` results),
  dates formatted by `Intl`, the constant labels and class names of the guest-reporting panel, the static SVG icon table
  indexed by a key from the console's own catalogue, markup copied from one element of the page to another, and the
  fleet card's row builders (`agent-fleet.js`), whose every interpolation does go through `esc()`; the rule only sees a
  function call there.
- **Pinned:** `apps/web/test/escaping.test.js` fails if an id, operation or device key goes into an attribute without
  `esc()` again, and checks that hostile agent and build values come out of the fleet card as text.

One limit of the ratchet applies here: the baseline counts findings per file and rule, and a flagged statement counts
once. A raw value added to a statement that is already baselined does not raise the count. The test above covers the
shapes that mattered; a new kind of raw value in an old statement would need a review.

**Reviewed with a regression test, not only a rule: the noVNC route.** `apps/api/test/static-asset-paths.test.js`
requests the intended script (200) and twelve traversal, absolute-path and non-script paths (all 404, none of them
returning file content).

### What it does not tell you

- It is **pattern based**, not data-flow analysis. A clean run means none of these patterns appear outside the
  baseline; it does not mean there are no injection or authorisation flaws.
- The **baseline is "accepted as found"**, not "proven safe". The console entries were reviewed (above); the file-path
  and regular-expression entries were read for the cases that matter but not one by one.
- It does not read the **operating-system packages** of the container image; the image scan does that.
- Tests, `apps/web/vendor`, and the two build toolchains are not analysed.

## Licence review

**What runs.** `tools/evaluate-licenses.js` reads the lockfiles (the root one and the two toolchains'), takes each
package's licence from the lockfile, falls back to its installed `package.json` when the lockfile has none, and checks
it against `deploy/license-policy.json`. It writes `evidence/license-report.json` (CI keeps it with the release evidence).

- An **SPDX expression** is evaluated: `OR` is satisfied by any acceptable alternative, `AND` needs all of them.
- **Allowed** licences pass (MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0,
  CC-BY-4.0).
- **Weak copyleft** (MPL-2.0) passes only for a package named in the policy, with the reason written there.
- A package whose licence cannot be read from its metadata needs a **determination** bound to its exact name and
  version, so an upgrade has to be re-reviewed.
- An **exception** carries an expiry date and a reviewer; one with a review date may not run past 120 days.
- A **deny list** (GPL, AGPL, LGPL, SSPL, BUSL, CC-BY-NC, CC-BY-SA, EUPL, OSL, UNLICENSED, "SEE LICENSE…", proprietary)
  wins over the allow list.

```bash
npm run licenses
```

**Result today:** 325 packages (101 runtime, 8 development, 126 agent packager toolchain, 90 static analysis
toolchain): 322 allowed and 3 reviewed under MPL-2.0 (noVNC, served unmodified to the browser; axe-core, used only by
the browser tests; eslint-plugin-no-unsanitized, in the static-analysis toolchain), 0 exceptions, no findings. Two
more packages have no `license` field in the registry and are accepted by a determination bound to their exact version
(`buildcheck` 0.0.7, `cpu-features` 0.0.10, both optional build helpers of `ssh2`).

### What it does not tell you

- It trusts the **declared** licence of a package. It does not read licence files or detect code copied between
  packages.
- It covers what npm installs. The **operating-system packages** in the base image and the container image's own
  licences are not covered.
- It does not bundle the licence texts into the release. If a customer needs a notice file, that is a separate step.

## Dependency override: @azure/msal-node (27 October 2026)

`npm audit` and the image scan both reported GHSA-xcx6-jx8p-x3h5 (HIGH): before 7.1.0, `@azure/msal-node` may disclose authorization-code parameters to an attacker-controlled endpoint. It reaches the product only through
`@azure/identity`, which the Azure adapter uses. The adapter signs in with a client secret (`ClientSecretCredential`, the client-credentials flow), not the authorization-code flow, so the product was probably not exposed,
but both gates block on the finding and the release was held.

`@azure/identity` 4.13.3 and 4.14.0 declare `@azure/msal-node` `^6.0.0`, so `npm update` cannot reach the fix. `package.json` therefore carries `"overrides": { "@azure/msal-node": "^7.1.1" }`, which locks 7.1.1 (with its own
`@azure/msal-common` 16.14.3). What this does **not** prove: the pairing is not one `@azure/identity` declares support for, and the Azure adapter has never run against a real subscription (its tests use a fake client, so
they do not touch msal-node). A test pins the override and the locked version.

**Remove the override** when a release of `@azure/identity` depends on a fixed msal-node; then run `npm install`, the audit and the tests, and delete the guard test. Until the Azure adapter is validated live, treat a first
real Azure sign-in as the proof that the pairing works.

