# Plan 003: Preserve **proto** accessors throughout namespace construction

> **Executor instructions:** Read this entire plan before editing. Follow the steps and verification gates; stop on the conditions below. This is an implementation handoff, not authorization to publish, push, or merge. Update only your status row in `plans/README.md` when done, unless your reviewer owns that index.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- src/module-composition/module-namespaces.ts src/accessors.ts test/runs/accessors.test.ts test/runs/module-composition.test.ts` and `git status --short`. Compare the excerpts below against the live code, including uncommitted changes. A changed line number alone is harmless; changed behavior or signatures require plan reconciliation before implementation. Files newly created by this plan must not already contain unrelated work.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW
- **Depends on:** None; independent of lifecycle fixes, but avoid simultaneous edits to the shared public test file.
- **Category:** bug
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #3

## Why this matters

The public API accepts `__proto__` as an entry name and advertises all identifier names as safe, but ordinary-object intermediate dictionaries invoke the inherited prototype setter instead of storing that key. The final null-prototype accessor objects therefore never receive the accessor. This is a confirmed defect against both documentation and the original hardening intent, not a proposal to expand supported names.

## Current state

Repository: `/Users/erolyildiz/Projects/terrain`. All paths below are relative to its root, so an isolated checkout can use the same commands. Terrain is the ESM-only `terrain-di` TypeScript library: named modules compose into a fixed graph; the public entrypoint is `src/index.ts`. The token engine under `src/container/` is internal. There are no runtime dependencies. Do not add decorators, runtime registration, public tokens, or hot-swap behavior.

`src/module-composition/module-namespaces.ts:16`:

```ts
export function buildNamespacePrototypes(
  tokensByEntryName: ReadonlyMap<ModuleEntryName, AnyToken<unknown>>,
): NamespacePrototypes {
  const allEntries: AccessorSpec = {};
  const syncEntries: SyncAccessorSpec = {};

  for (const [entryName, token] of tokensByEntryName) {
    allEntries[entryName] = token;
    if (!isAsyncToken(token)) {
      syncEntries[entryName] = token;
    }
  }

  return {
    full: buildAccessorPrototype(allEntries),
    syncOnly: buildSyncAccessorPrototype(syncEntries),
  };
```

`src/accessors.ts:73`:

```ts
export function buildSyncAccessorPrototype(spec: SyncAccessorSpec): AccessorPrototype<SyncResolver> {
  const resolversByName: Record<string, (source: SyncResolver) => unknown> = {};
  for (const [name, token] of Object.entries(spec)) resolversByName[name] = (source) => source.get(token);
  return new AccessorPrototype(resolversByName);
}

export function buildAccessorPrototype(spec: AccessorSpec): AccessorPrototype<AsyncResolver> {
  const resolversByName: Record<string, (source: AsyncResolver) => unknown> = {};
  for (const [name, token] of Object.entries(spec)) {
    resolversByName[name] = isAsyncToken(token) ? (source) => source.getAsync(token) : (source) => source.get(token);
  }
  return new AccessorPrototype(resolversByName);
```

`test/runs/module-composition.test.ts:350`:

```ts
it("entries named like accessor internals resolve to their values", () => {
  const M = createModule("M", (m) =>
    m
      .single("source", () => "S")
      .single("accessorCache", () => "C")
      .single("toString", () => "T"),
  );
  const app = createContainer({ parts: [M] });

  expect(app.M.source()).toBe("S");
  expect(app.M.accessorCache()).toBe("C");
  expect(app.M.toString()).toBe("T");
});
```

`src/accessors.ts:40` explicitly says `toString/constructor/__proto__` are ordinary accessor keys. `STATUS.md:39` permits any identifier entry name. The intermediate maps above are the missing protection; the frozen prototypes, symbol-keyed instance state, and lazy accessor cache are already intentional. Example of the existing correct dictionary convention: `src/module-composition/module-namespaces.ts:45` uses `const namespaces: Record<string, unknown> = Object.create(null);`.

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

| Purpose                         | Command                                                                            | Expected result                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Focused verification            | `bun run test -- test/runs/accessors.test.ts test/runs/module-composition.test.ts` | Exit 0 for the completed plan; intentional baseline failures are identified in Steps |
| Source, test, and example types | `bun run typecheck:all`                                                            | Exit 0, no diagnostics                                                               |
| Lint                            | `bun run lint`                                                                     | Exit 0; no new warnings                                                              |
| Format check                    | `bun run format`                                                                   | Exit 0                                                                               |
| Full release-quality gate       | `bun run quality`                                                                  | Exit 0; all correctness tests and existing coverage gates pass                       |
| Build                           | `bun run build`                                                                    | Exit 0; `dist/index.js` and `dist/index.d.ts` produced                               |
| Scope review                    | `git diff --check` and `git status --short`                                        | No whitespace errors; changes limited to allowed files and this plan's index row     |

`quality` runs lint, format checking, all three typechecks, and coverage-gated Vitest. `build` runs tsdown. These last two commands are executor verification gates, not commands the read-only advisor ran. Build artifacts belong in ignored `dist/`; remove only temporary artifacts created by your own run if necessary. Never run `quality:fix` or a repository-wide formatter; format only files you changed.

## Scope

**Only these files may be changed or created:**

- `src/module-composition/module-namespaces.ts`
- `src/accessors.ts`
- `test/runs/accessors.test.ts`
- `test/runs/module-composition.test.ts`
- `plans/README.md` — only this plan's status row and completion evidence.

Every other file is out of scope. In particular, do not update versions, dependencies, lockfiles, exports, or engine/public behavior beyond the task described here unless specifically listed and required by a step.

## Git workflow

Use an isolated branch named `codex/003-preserve-prototype-named-accessors`. Preserve any existing user changes. Do not commit, push, merge, publish a package, create an issue, or open a PR without operator instructions. If a commit is requested, match the repository's concise conventional style, e.g. `fix: preserve async resource disposal` or `test: verify package consumers`.

## Steps

### Step 1: Pin the public and internal failure

Add a test group named `prototype-named accessors` to both listed test files. Publicly register `single("__proto__", () => 42)` and assert the call returns 42. For the internal helper, use a computed-key object `{ ["__proto__"]: token }` or a null-prototype spec; a literal `{ __proto__: token }` has special object-literal semantics and would test the wrong layer. Include `buildSyncAccessorPrototype` through a direct internal source import if it cannot otherwise be exercised by the existing shim; do not change package exports.

**Verify:** `bun run test -- test/runs/accessors.test.ts test/runs/module-composition.test.ts -t 'prototype-named accessors'` → baseline failure from a missing accessor. `bun run typecheck:all` → exit 0.

### Step 2: Preserve keys in every intermediate dictionary

Replace both entry-spec dictionaries in `buildNamespacePrototypes` and both resolver dictionaries in `buildSyncAccessorPrototype`/`buildAccessorPrototype` with null-prototype dictionaries, retaining their explicit TypeScript annotations. Keep iteration, lazy resolution, symbol state, freezing, and caching unchanged. Do not blacklist `__proto__`, add a new reserved name, change the public API, or replace every object in the repository.

**Verify:** `bun run test -- test/runs/accessors.test.ts test/runs/module-composition.test.ts` → exit 0. `bun run typecheck:all` → exit 0.

### Step 3: Cover imported, asynchronous, and scoped accessors

Add the matrix below and check destructuring still returns a usable cached closure. Assert public namespace/accessor containers remain frozen. A module named `__proto__` is already supported by another null-prototype map; include it as a nonregression case rather than changing its implementation.

**Verify:** `bun run quality` and `bun run build` → exit 0. `git diff --check` → exit 0.

## Test plan

- Sync and async entries named `__proto__` resolve through the exposed namespace.
- A consuming module accesses the key through both sync-only and full async provider namespaces.
- A scope uses the same key with scoped lifetime and disposal still works.
- Internal `createAccessors` accepts a computed-key spec and returns a callable key.
- Existing `toString`, `constructor`, `source`, and `accessorCache` behavior remains intact; no inherited machinery is exposed.
- Follow `test/runs/accessors.test.ts:8` for shared-container assertions and `module-composition.test.ts:350` for name regressions.

## Done criteria

- [ ] Public and internal `__proto__` calls return the registered values in sync and async paths.
- [ ] All four intermediate dictionaries preserve own enumerable `__proto__` keys.
- [ ] No identifier-validation or reserved-name changes.
- [ ] `bun run test -- test/runs/accessors.test.ts test/runs/module-composition.test.ts` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 without lowered thresholds or ignored regressions.
- [ ] `git diff --check` exits 0 and changed files match Scope.
- [ ] Update `plans/README.md` with DONE and a compact record of commands/results, or BLOCKED with a concrete reason. Do not mark DONE if a required runtime/toolchain check could not run.

## STOP conditions

- Current-state behavior/signatures differ from these excerpts, except a prerequisite change whose effect has been reviewed and reconciled into this plan.
- A verification gate fails twice after a reasonable correction, or a required dependency/toolchain is unavailable.
- The work requires an out-of-scope source/configuration change, weaker tests/types, new runtime dependencies, or public behavior not authorized below.
- A suggested fix depends on rejecting previously supported names or exposing internal engine types from the package entrypoint.
- The test fixture uses object-literal prototype syntax rather than a real own property and therefore does not reproduce the audited defect.

## Maintenance notes

Null-prototype safety must hold at every name-to-value mapping, not only the final exposed object. Review future `Record<string, ...> = {}` additions on user-named paths. Keep regressions at both composition and accessor-helper boundaries so one layer cannot mask another.
