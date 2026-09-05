# Plan 006: Verify the packed package and declared consumer runtime boundary

> **Executor instructions:** Read the entire plan, follow the steps and verification gates, and stop on the conditions below. Update your status row in `plans/README.md` when done unless a reviewer maintains it. This handoff does not authorize publishing, pushing, or merging.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- package.json .github/workflows/ci.yml scripts/test-package.mjs test/package-consumer/package.json test/package-consumer/runtime.mjs test/package-consumer/types.ts test/package-consumer/tsconfig.nodenext.json test/package-consumer/tsconfig.bundler.json tsconfig.test.json` and `git status --short`. Compare excerpts against live code and any uncommitted changes. Line-number movement alone is harmless; changed behavior/signatures require reconciliation. Do not overwrite unrelated files at newly proposed paths.

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** LOW
- **Depends on:** None to create the package boundary. Run after plans 001–005 when validating the final combined artifact.
- **Category:** tests
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #6

## Why this matters

Current tests and examples import source, so a green gate does not prove that consumers can import the distributed export map or use its bundled declarations. CI builds dist but then runs source-importing examples under Bun, while the package declares Node >=20. This is a verification gap, not evidence that today's built artifact is broken. Add isolated consumer checks using only packed files, without requiring registry installation.

## Current state

Repository: `/Users/erolyildiz/Projects/terrain`; all paths are repository-relative so isolated checkouts can run the same commands. Terrain is an ESM-only TypeScript DI library published as `terrain-di`, with no runtime dependencies. `src/index.ts` exposes named static composition and errors; the token engine is internal. Preserve static composition, explicit namespace exposure, typed sync/async separation, and explicit opt-in cleanup.

`package.json:23`:

```json
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "type": "module",
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
```

`package.json:42`:

```json
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc -p tsconfig.json",
    "typecheck:test": "tsc -p tsconfig.test.json",
    "typecheck:examples": "tsc -p examples/tsconfig.json",
    "typecheck:all": "bun run typecheck && bun run typecheck:test && bun run typecheck:examples",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "format": "oxfmt --check",
    "format:fix": "oxfmt",
    "quality": "bun run lint && bun run format && bun run typecheck:all && bun run test:coverage",
    "quality:fix": "bun run lint:fix && bun run format:fix && bun run typecheck:all && bun run test:coverage",
    "prepublishOnly": "bun run quality && bun run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  },
```

`.github/workflows/ci.yml:15`:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24

- uses: oven-sh/setup-bun@v2
  with:
    bun-version: 1.3.14

- name: Install dependencies
  run: bun install --frozen-lockfile

# Lint, format check, both typechecks, and the test suite with enforced
# coverage thresholds. Same gate as local development.
- name: Quality gate
  run: bun run quality

- name: Build
  run: bun run build

- name: Run examples
  run: |
    bun examples/public-api-usage.ts
    bun examples/engine.ts
```

`examples/public-api-usage.ts:9`:

```ts
 */

import { createContainer, createModule } from "../src";
```

`tsdown.config.ts` builds `src/index.ts` into ESM `dist/index.js` and bundled `dist/index.d.ts` at ES2022. `package.json:70` declares Node >=20. Source TypeScript uses bundler module resolution and skipLibCheck; a separate consumer declaration check should use both NodeNext and bundler resolution with skipLibCheck disabled. Keep library build tooling on the existing Node 24 job; the minimum consumer runtime must not be forced to execute modern Vite/tsdown tooling.

`test/package-consumer/` and `scripts/test-package.mjs` do not exist at the planned revision. A fixture under `test/` would otherwise be included by `tsconfig.test.json`, so explicitly exclude only `test/package-consumer` from the ordinary source-test typecheck and check it through the dedicated harness instead. Its files must not match `*.test.ts` so Vitest does not execute them through source transforms.

### Conventions and verification baseline

Match existing two-space indentation, semicolons, double quotes, strict TypeScript, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. Use explicit names for lifecycle state and map key/value relationships. Comments should explain ordering and safety invariants. Preserve framework errors and flattened `AggregateError` handling; never swallow an error merely to make a test pass.

Tests use Vitest imports and explicit assertions. The public type-test convention in `test/runs/types.test.ts:20` is:

```ts
expectTypeOf(app.Infra.logger).toEqualTypeOf<() => Logger>();
expectTypeOf(app.Infra.logger()).not.toBeAny();
```

Negative type tests use `@ts-expect-error` inside a nonexecuted function. They are checked by `bun run typecheck:test`, not by Vitest alone. Runtime regressions should use public imports from `../../src` where practical; engine tests use `test/internal-api.ts`.

At the audited revision, `bun run test` passed 199 tests with one intentionally skipped measurement; lint exited 0 with seven warnings; formatting and source/test/example typechecks passed. Coverage and a new build were not run by the advisor. Do not weaken existing coverage thresholds (99% statements, 97% branches, 99% functions, 100% lines), add ignore directives to hide new paths, or silence pre-existing warnings as unrelated cleanup.

## Commands you will need

Run from the repository root. Use the pinned Bun 1.3.14 toolchain when available; the advisor's installed Bun was 1.3.8. Do not upgrade dependencies as part of this plan. If dependencies are missing, stop and report the prerequisite rather than changing the lockfile.

| Purpose                         | Command                                     | Expected result                                                                      |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Focused verification            | `bun run build && bun run test:package`     | Exit 0 for the completed plan; intentional baseline failures are identified in Steps |
| Source, test, and example types | `bun run typecheck:all`                     | Exit 0, no diagnostics                                                               |
| Lint                            | `bun run lint`                              | Exit 0; no new warnings                                                              |
| Format check                    | `bun run format`                            | Exit 0                                                                               |
| Full release-quality gate       | `bun run quality`                           | Exit 0; all correctness tests and existing coverage gates pass                       |
| Build                           | `bun run build`                             | Exit 0; `dist/index.js` and `dist/index.d.ts` produced                               |
| Scope review                    | `git diff --check` and `git status --short` | No whitespace errors; changes limited to allowed files and this plan's index row     |

`quality` runs lint, format checking, all three typechecks, and coverage-gated Vitest. `build` runs tsdown. These last two commands are executor verification gates, not commands the read-only advisor ran. Build artifacts belong in ignored `dist/`; remove only temporary artifacts created by your own run if necessary. Never run `quality:fix` or a repository-wide formatter; format only files you changed.

## Scope

Only these files may be changed or created:

- `package.json`
- `.github/workflows/ci.yml`
- `scripts/test-package.mjs`
- `test/package-consumer/package.json`
- `test/package-consumer/runtime.mjs`
- `test/package-consumer/types.ts`
- `test/package-consumer/tsconfig.nodenext.json`
- `test/package-consumer/tsconfig.bundler.json`
- `tsconfig.test.json`
- `plans/README.md` — this plan's status row and completion evidence only.

Every other file is out of scope. Do not change versions, runtime dependencies, lockfiles, public exports, or unrelated lifecycle behavior. A listed configuration file may change only as specifically required below.

## Git workflow

Use an isolated branch `codex/006-verify-distributed-package`. Preserve user changes. Do not commit, push, merge, publish, create issues, or open a PR without operator instructions. If asked to commit, use concise conventional messages consistent with repository history, such as `fix: preserve namespace alternatives` or `docs: clarify factory disposal ownership`.

## Steps

### Step 1: Add the isolated consumer fixture and package harness

Create `scripts/test-package.mjs` using Node built-ins only. Create a unique directory beneath repository-ignored `tmp/` with `fs.mkdtemp`; determine the repository from `import.meta.url`, not the caller's arbitrary working directory. Invoke `npm pack --ignore-scripts --json --pack-destination <temp>` from the repository and check its exit status. `--ignore-scripts` is essential to prevent prepublish recursion. Verify the reported tarball contains package.json, README, LICENSE, dist/index.js, and dist/index.d.ts and excludes src, tests, plans, and credentials/configuration not intended for release.

Extract the generated tarball into a fresh fixture's `node_modules/terrain-di` with the package directory layout intact. Use the generated archive only, not a symlink to the checkout. On supported CI/local platforms, system `tar` is available; invoke it through `spawnSync` with an argument array, validate the archive's listed paths stay beneath `package/`, and propagate failures. Do not install anything from npm or fetch a different package version.

Copy the fixture package.json, runtime script, type source, and configs into this isolated fixture. Its package.json marks ESM. Initially create a minimal runtime assertion that public createModule/createContainer imports are functions, and a type fixture that constructs one numeric entry. The two standalone configs include only `types.ts`; they must not extend the repository config or its source includes. `runtime.mjs` imports `terrain-di` by package name and uses `node:assert/strict`; all type fixture imports also use that package name. Add `"test:package": "node scripts/test-package.mjs"` to package scripts. This harness assumes dist was just built and fails clearly if missing; it must not run build/prepublish internally.

**Verify:** `bun run build && bun run test:package` → exit 0 with the minimal fixture; child failures propagate nonzero. Step 2 expands the consumer contracts. `bun run typecheck:all` → exit 0 after the targeted fixture exclusion.

### Step 2: Exercise runtime and bundled declarations

Runtime fixture: assert a sync singleton is shared, async calls coalesce, an override changes a dependency through a consumer module, transitive modules are not publicly exposed, and a callback scope disposes its resource exactly once. Assert the internal `Container`/token API is not exported, and an unsupported package subpath rejects with the appropriate Node package-export error. Catch errors only to assert the expected rejection; do not log-and-succeed.

Type fixture: add exact inferred assignment checks and compile-only negative controls for invalid keys, wrong overrides, hidden namespaces, and async access from sync providers. Run installed TypeScript via its absolute repository CLI path, with the consumer directory as cwd and both fixture configs using `noEmit: true`, `strict: true`, and `skipLibCheck: false`. One config uses module/moduleResolution NodeNext; the other uses ESNext/bundler. Do not alias `terrain-di` back to source or add paths/baseUrl shortcuts. Keep ambient types empty unless the fixture itself needs a deliberate import.

The harness has two modes: default performs runtime plus both typechecks and always cleans its owned temp directory in `finally`; `--prepare-only <output-directory>` builds a persistent isolated fixture for CI artifact upload without executing consumer tests. Validate the output directory is an explicit fresh destination; never remove an existing caller directory. Its runtime fixture must be runnable independently as `node <output-directory>/runtime.mjs`.

**Verify:** `bun run build && bun run test:package` → exit 0 with explicit success for runtime, NodeNext types, and bundler types. Deliberately break one assertion in the copied temporary fixture during development and verify a nonzero exit, then discard only that temporary copy.

### Step 3: Add consumer CI jobs without moving build tools to Node 20

Keep the existing Node 24 quality/build job. After build, run `bun run test:package`; run prepare-only into a fresh `tmp/package-consumer-ci` directory and upload it as an artifact including `node_modules/terrain-di`. Artifact tooling may exclude hidden paths by default; ensure the selected directory retains the entire fixture and package. Use official artifact actions consistent with the workflow's existing major-version style; no broad CI modernization.

Add a dependent matrix job that downloads the prepared artifact and runs only its runtime script on Node 20.0.0 (the declared minimum, not merely latest Node 20) and Node 24. No Bun, install, tsdown, or Vitest is needed in those consumer jobs. Tooling support and product runtime support are distinct. Add `test:package` after build in `prepublishOnly`, leaving source quality and build gates intact. Do not put it into `quality`, which currently runs before build.

**Verify:** `bun run quality && bun run build && bun run test:package` → exit 0 locally. CI consumer matrix → both exact minimum and development-runtime executions exit 0. If minimum Node is unavailable locally, report that check pending until CI provides evidence; do not silently raise `engines.node` to make it pass.

## Test plan

- Runtime consumers import only the extracted tarball by package name; no source aliases or checkout symlinks.
- Public namespace shape, lifetimes, async coalescing, overrides, scope cleanup, and internal-export exclusion.
- Bundled `.d.ts` checked in NodeNext and bundler modes with strict settings and skipLibCheck false.
- Consumer check works from a fresh artifact on declared minimum Node without dev tooling installed.
- Harness propagates child process/assertion/compiler failures and cleans only its own temporary directory.
- Prepublish pack invocation cannot recursively execute lifecycle scripts.
- Use existing public examples as provider wiring style, but import `terrain-di` rather than `../src`.

## Done criteria

- [ ] `bun run build && bun run test:package` passes against an extracted archive, including two declaration checks.
- [ ] Package fixture confirms required distributed files and absence of source/tests/plans.
- [ ] CI runtime checks pass on Node 20.0.0 and Node 24 using the same built artifact.
- [ ] Prepublish verification runs consumer checks after build without recursive pack scripts.
- [ ] Ordinary test typechecks explicitly exclude only the independently checked package fixture.
- [ ] `bun run build && bun run test:package` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 with no weakened checks.
- [ ] `git diff --check` exits 0; changed files stay within Scope.
- [ ] Update `plans/README.md` with DONE plus commands/results, or BLOCKED with a concrete explanation. Do not claim unrun compatibility checks passed.

## STOP conditions

- Current-state signatures/behavior have drifted, including prerequisites, and have not been reconciled into the plan.
- Required toolchains/dependencies are unavailable; do not silently upgrade packages or edit the lockfile.
- A gate fails twice after reasonable correction or the solution requires out-of-scope changes.
- The packed artifact is actually broken and fixing it requires source/export/build changes beyond Scope; report the concrete failure for a follow-up plan.
- A consumer check needs a network registry install or changes to the lockfile.
- Minimum-runtime verification fails: do not change the declared support range without maintainer direction.
- Artifact preparation would delete unrelated output or depend on symlinks back into the source checkout.

## Maintenance notes

This boundary guards published behavior independently from source correctness. Future export-map or build changes must run these consumer checks. Keep the minimum-runtime job independent from development-tool engine requirements; update its exact version only alongside an intentional support-policy change.
