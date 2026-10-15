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
After the XML fix below the baseline is **133**:

| Rule | Baseline | Where |
|---|---:|---|
| `no-unsanitized/property`, `/method` | 67 | `apps/web/app.js` (64), `apps/web/agent-fleet.js` (3): HTML strings the rule cannot prove are escaped |
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

**Still open on this finding:** the five `await response.text()` reads of SOAP replies have no size limit, so a reply of
hundreds of megabytes is read into memory. The time cost is now linear and small; the memory cost is not bounded. The
endpoints are administrator-configured and TLS-pinned, which is why this was left as a separate, smaller change.

**The remaining `detect-unsafe-regex` entries** were read: they are anchored, bounded (`{0,500}`), or each scan
consumes a distinct run of input, so they are linear in practice; the rule flags nested optional groups as a pattern,
not as a measurement. They stay in the baseline until someone replaces them with something the rule can see through.

**Reviewed with a regression test, not only a rule: the noVNC route.** `apps/api/test/static-asset-paths.test.js`
requests the intended script (200) and twelve traversal, absolute-path and non-script paths (all 404, none of them
returning file content).

### What it does not tell you

- It is **pattern based**, not data-flow analysis. A clean run means none of these patterns appear outside the
  baseline; it does not mean there are no injection or authorisation flaws.
- The **baseline is "accepted as found"**, not "proven safe". The 67 console findings in particular are worth a
  per-finding review the next time `app.js` is touched; every `innerHTML` assignment should go through `esc()`.
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
