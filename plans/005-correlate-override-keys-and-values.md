# Plan 005: Require override keys to identify one entry with its matching value type

> **Executor instructions:** Read the entire plan, follow the steps and verification gates, and stop on the conditions below. Update your status row in `plans/README.md` when done unless a reviewer maintains it. This handoff does not authorize publishing, pushing, or merging.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- src/module-composition/types.ts src/module-composition/module-override/build-module-overrides.ts test/runs/types.test.ts` and `git status --short`. Compare excerpts against live code and any uncommitted changes. Line-number movement alone is harmless; changed behavior/signatures require reconciliation. Do not overwrite unrelated files at newly proposed paths.

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** MED
- **Depends on:** Plan 004 for sequential editing/reconciliation of shared public type definitions; no runtime dependency.
- **Category:** bug
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #5

## Why this matters

An override key typed as a union makes the provider return type a union of all selected value types. A string provider can therefore replace a numeric entry while consumers continue to infer number. The documented replacement-value contract is violated. The recommended bounded repair is to require a narrowed single entry key; accepting arbitrary dynamic unions safely is not a goal of this plan.

## Current state

Repository: `/Users/erolyildiz/Projects/terrain`; all paths are repository-relative so isolated checkouts can run the same commands. Terrain is an ESM-only TypeScript DI library published as `terrain-di`, with no runtime dependencies. `src/index.ts` exposes named static composition and errors; the token engine is internal. Preserve static composition, explicit namespace exposure, typed sync/async separation, and explicit opt-in cleanup.

`src/module-composition/types.ts:168`:

```ts
/** Override providers may resolve the module's OTHER entries (Omit of the one
 *  being replaced); the original's imports are reachable at runtime but not
 *  typed here — fakes are expected to be self-contained. */
export interface OverrideBuilder<ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap> {
  with<EntryName extends SyncEntryNamesOf<ModuleEntries> & ModuleEntryName>(
    entryName: EntryName,
    provider: (
      resolver: SyncProviderResolver<ModuleName, readonly [], Omit<ModuleEntries, EntryName>>,
    ) => EntryValueOf<ModuleEntries, EntryName>,
    options?: SingletonDefinitionOptions<EntryValueOf<ModuleEntries, EntryName>>,
  ): OverrideBuilder<ModuleName, ModuleEntries>;
  withAsync<EntryName extends AsyncEntryNamesOf<ModuleEntries> & ModuleEntryName>(
    entryName: EntryName,
    provider: (
      resolver: AsyncProviderResolver<ModuleName, readonly [], Omit<ModuleEntries, EntryName>>,
    ) => Promise<EntryValueOf<ModuleEntries, EntryName>>,
    options?: SingletonDefinitionOptions<EntryValueOf<ModuleEntries, EntryName>>,
  ): OverrideBuilder<ModuleName, ModuleEntries>;
}
```

`src/module-composition/module-override/build-module-overrides.ts:66`:

```ts
  const collectSyncReplacement = <EntryName extends ModuleEntryName>(
    entryName: EntryName,
    provider: SyncModuleEntryProvider<ModuleName, ModuleEntries, EntryName>,
    options?: SingletonDefinitionOptions<unknown>,
  ): OverrideBuilder<ModuleName, ModuleEntries> => {
    const original = assertEntryCanBeReplaced(entryName, TokenModes.Sync, options);
    replacementsByEntryName.set(entryName, { ...original, provider: eraseSyncEntryProvider(provider), options });
    return overrideBuilder;
  };

  const collectAsyncReplacement = <EntryName extends ModuleEntryName>(
    entryName: EntryName,
    provider: AsyncModuleEntryProvider<ModuleName, ModuleEntries, EntryName>,
    options?: SingletonDefinitionOptions<unknown>,
  ): OverrideBuilder<ModuleName, ModuleEntries> => {
    const original = assertEntryCanBeReplaced(entryName, TokenModes.Async, options);
    replacementsByEntryName.set(entryName, { ...original, provider: eraseAsyncEntryProvider(provider), options });
    return overrideBuilder;
  };

  const overrideBuilder: OverrideBuilder<ModuleName, ModuleEntries> = {
```

`test/runs/types.test.ts:87`:

```ts
  it("override .with/.withAsync infer the original entry's value type", () => {
    const Infra = createModule("Infra", (m) =>
      m.single("logger", (): Logger => ({ info() {} })).singleAsync("config", async () => ({ env: "prod" as const })),
    );
    Infra.override((o) =>
      o.with("logger", (): Logger => ({ info() {} })).withAsync("config", async () => ({ env: "prod" as const })),
    );
    // The provider return types above must satisfy the original entry types;
    // a wrong return type here would be a tsc error caught by typecheck:test.
    expectTypeOf(Infra.override).toBeFunction();
```

`README.md:371` says override entry names, value types, and sync/async mode must match. Runtime replacement checks know token mode and entry existence, but TypeScript return types do not exist at runtime. Do not add value guessing or runtime schema validation.

Baseline accepted example:

```ts
const M = createModule("M", (m) => m.single("count", () => 1).single("text", () => "text"));
function replacement(key: "count" | "text") {
  return M.override((o) => o.with(key, () => "replacement"));
}
const app = createContainer({ parts: [M, replacement("count")] });
const value: number = app.M.count(); // runtime value is a string
```

Literal `with("count", () => "wrong")` already fails and must remain a control. The runtime builder has an intentional type-erasure seam; do not remove or broaden it opportunistically.

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
| Focused verification            | `bun run typecheck:all`                     | Exit 0 for the completed plan; intentional baseline failures are identified in Steps |
| Source, test, and example types | `bun run typecheck:all`                     | Exit 0, no diagnostics                                                               |
| Lint                            | `bun run lint`                              | Exit 0; no new warnings                                                              |
| Format check                    | `bun run format`                            | Exit 0                                                                               |
| Full release-quality gate       | `bun run quality`                           | Exit 0; all correctness tests and existing coverage gates pass                       |
| Build                           | `bun run build`                             | Exit 0; `dist/index.js` and `dist/index.d.ts` produced                               |
| Scope review                    | `git diff --check` and `git status --short` | No whitespace errors; changes limited to allowed files and this plan's index row     |

`quality` runs lint, format checking, all three typechecks, and coverage-gated Vitest. `build` runs tsdown. These last two commands are executor verification gates, not commands the read-only advisor ran. Build artifacts belong in ignored `dist/`; remove only temporary artifacts created by your own run if necessary. Never run `quality:fix` or a repository-wide formatter; format only files you changed.

## Scope

Only these files may be changed or created:

- `src/module-composition/types.ts`
- `src/module-composition/module-override/build-module-overrides.ts`
- `test/runs/types.test.ts`
- `plans/README.md` — this plan's status row and completion evidence only.

Every other file is out of scope. Do not change versions, runtime dependencies, lockfiles, public exports, or unrelated lifecycle behavior. A listed configuration file may change only as specifically required below.

## Git workflow

Use an isolated branch `codex/005-correlate-override-keys-and-values`. Preserve user changes. Do not commit, push, merge, publish, create issues, or open a PR without operator instructions. If asked to commit, use concise conventional messages consistent with repository history, such as `fix: preserve namespace alternatives` or `docs: clarify factory disposal ownership`.

## Steps

### Step 1: Add union-key negative type tests

In `test/runs/types.test.ts`, add a group named `override key value correlation`. Put union-key examples in nonexecuted functions. Assert with `@ts-expect-error` that a `"count" | "text"` variable cannot choose an override with an incompatible provider. Mirror this for two async entries. Keep invalid literal replacements as controls and add exact/not-any assertions for successful literal replacements.

**Verify:** `bun run typecheck:test` → baseline unused-expect-error diagnostics only for the unsound union cases; literal controls continue to reject. `bun run test -- test/runs/types.test.ts` → exit 0.

### Step 2: Require a single narrowed key without inference escape hatches

Add a private type-level single-key constraint for both `OverrideBuilder.with` and `withAsync`. Infer the key from the key argument; prevent provider/options inference from widening it into a union that escapes the constraint. Reject unresolved union keys consistently, including explicit union generic arguments. A conservative rejection of unions whose entries happen to share a value type is acceptable for this plan and should be stated in a short signature-adjacent contract comment.

Retain the original entry value and resolver types for literal or control-flow-narrowed keys. Do not replace provider result types with `unknown`/`any`, weaken contextual resolver typing, or use overloads that leave an unconstrained fallback callable from public code. Only adjust `build-module-overrides.ts` if the strengthened interface requires a narrowly contained implementation adaptation; no provider/lifetime/disposal behavior changes.

**Verify:** `bun run typecheck:all` → exit 0 with all new negative cases enforced; existing examples and override type tests pass. `bun run test -- test/runs/module-composition.test.ts test/runs/types.test.ts` → exit 0.

### Step 3: Verify supported narrowing and generic escape cases

Add a positive helper that branches on the key and calls `with("count", () => 2)` or `with("text", () => "replacement")` only after narrowing. Mirror async methods. Verify providers still receive other-entry resolver namespaces, self-reference remains excluded, mode errors remain rejected, and disposer options receive the original entry value type. Include explicit type arguments and an unresolved generic key to ensure callers cannot reintroduce the union mismatch.

**Verify:** `bun run quality` and `bun run build` → exit 0. `git diff --check` → exit 0.

## Test plan

- Mixed-value union keys rejected for sync and async overrides.
- Explicit union generic arguments and unresolved generic keys cannot bypass correlation.
- Literal and control-flow-narrowed keys retain exact provider, resolver, and disposer types.
- Invalid literal value/mode controls still fail.
- Same-value unions are conservatively rejected; narrowed calls are the supported replacement.
- The provider cannot access its own replaced entry, but may access other entries as before.
- Tests follow the compile-only function and expectTypeOf patterns in `test/runs/types.test.ts`; no new runtime-only tests are required for this purely static restriction.

## Done criteria

- [ ] Baseline union-key examples produce type errors without casts or runtime validation.
- [ ] Literal and narrowed calls preserve value, mode, and disposer typing.
- [ ] No expanded public `any`, overload escape hatch, or runtime ownership change.
- [ ] `bun run typecheck:all` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 with no weakened checks.
- [ ] `git diff --check` exits 0; changed files stay within Scope.
- [ ] Update `plans/README.md` with DONE plus commands/results, or BLOCKED with a concrete explanation. Do not claim unrun compatibility checks passed.

## STOP conditions

- Current-state signatures/behavior have drifted, including prerequisites, and have not been reconciled into the plan.
- Required toolchains/dependencies are unavailable; do not silently upgrade packages or edit the lockfile.
- A gate fails twice after reasonable correction or the solution requires out-of-scope changes.
- Rejecting unresolved keys breaks an existing repository example that cannot be repaired by ordinary narrowing without a public API decision; report it first.
- The proposed type guard accepts an explicit union type argument or lets return-type inference widen the key.
- The runtime builder adaptation would require broader unchecked casts or changes to validation semantics.

## Maintenance notes

This intentionally tightens accepted TypeScript inputs, so release notes should mention that dynamic override keys must be narrowed. Whether to support correlated unions of entire argument tuples is a later API design question; do not add it here. Coordinate with namespace typing changes and preserve their tests.
