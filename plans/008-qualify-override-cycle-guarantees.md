# Plan 008: Qualify acyclicity guarantees for typed overrides

> **Executor instructions:** Read the entire plan, follow the steps and verification gates, and stop on the conditions below. Update your status row in `plans/README.md` when done unless a reviewer maintains it. This handoff does not authorize publishing, pushing, or merging.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- README.md docs/TECHNICAL.md STATUS.md test/runs/module-composition.test.ts` and `git status --short`. Compare excerpts against live code and any uncommitted changes. Line-number movement alone is harmless; changed behavior/signatures require reconciliation. Do not overwrite unrelated files at newly proposed paths.

## Status

- **Priority:** P3
- **Effort:** S
- **Risk:** LOW
- **Depends on:** Plan 007 for documentation sequencing. Reconcile README/TECHNICAL excerpts; runtime behavior is independent.
- **Category:** docs
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #8

## Why this matters

Ordinary builder order prevents in-module cycles, but an override may resolve any other entry, including a later entry that depends on the replaced one. Such a fully typed public override can form a cycle and correctly throws at resolution. The defect is the composition-wide documentation promise, not the runtime cycle detector or the supported override capability.

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
```

`README.md:379`:

```text
The type system catches the wiring mistakes it can express:

- **In-module cycles are unwritable** — a provider can only reference entries defined before it.
- **Cross-module cycles are unwritable** — `uses` only accepts modules that already exist.
- **Sync providers can't reach async entries** of their imports.
- **Unknown module or entry names** are type errors.
- **Reserved module names** (`scope`, `start`, `dispose`) and **non-identifier module or entry names** are rejected before runtime.

Runtime backstops catch invalid dynamic input and lifecycle failures, each as a `DIError` subclass:

- **Module names must be identifiers and not reserved view names** (`InvalidModuleNameError`).
- **Entry names must be identifiers** (`InvalidEntryNameError`).
- **Duplicate entry and module names** are rejected (`DuplicateEntryNameError`, `DuplicateModuleNameError`).
- **Runtime dependency cycles through escape hatches** throw `CircularDependencyError`; concurrent async cycles are detected instead of hanging.
- **Only modules created by `createModule` are accepted** (`ForeignModuleError`).

### Circular dependencies

Through the composition API, cycles are structurally unwritable: an entry can only reference entries defined before it, and a module can only `uses` modules that already exist. The lower engine still backstops raw-engine/deep-import use. Direct cycles throw `CircularDependencyError`, and concurrent async cycles are tracked across in-flight resolutions so they throw instead of deadlocking.
```

`docs/TECHNICAL.md:64`:

```text
### Cycles are unrepresentable in typed code

- **In-module cycles** can't be written: a provider's resolver only exposes entries
  registered earlier in the chain, so an entry cannot reference itself or a later one.
- **Cross-module cycles** can't be written: `uses` only accepts modules that already
  exist, so a module cannot transitively depend on itself.

A cycle can still be forced through runtime escape hatches, including raw-engine
deep imports; those paths are caught at resolution with a clear error. Direct cycles
are caught by the current resolution chain. Concurrent async cycles are caught by an
in-flight wait graph, so two providers that coalesce onto each other's pending
`getAsync` calls throw `CircularDependencyError` instead of deadlocking.

That async check is intentionally conservative: `resolver.getAsync(T)` inside a
provider counts as dependency acquisition whether the returned promise is awaited,
returned, raced, or ignored. terrain reasons about the dependency graph, not
JavaScript await timing. The point is that _normal, typed_ code cannot express a
cycle at all.
```

`README.md:375` permits override providers to resolve the module's other entries. `STATUS.md:56` says in-module cycles are unwritable without the override qualification. Runtime `Container.checkCircularDependency` intentionally checks actual acquisition chains; concurrent async graph detection is conservative by design. Preserve both.

This public, cast-free example typechecks and throws `CircularDependencyError` today:

```ts
const M = createModule("M", (m) => m.single("base", () => 1).single("derived", (r) => r.M.base() + 1));
const fake = M.override((o) => o.with("base", (r) => r.M.derived()));
const app = createContainer({ parts: [M, fake] });
app.M.base();
```

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

| Purpose                         | Command                                                | Expected result                                                                      |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Focused verification            | `bun run test -- test/runs/module-composition.test.ts` | Exit 0 for the completed plan; intentional baseline failures are identified in Steps |
| Source, test, and example types | `bun run typecheck:all`                                | Exit 0, no diagnostics                                                               |
| Lint                            | `bun run lint`                                         | Exit 0; no new warnings                                                              |
| Format check                    | `bun run format`                                       | Exit 0                                                                               |
| Full release-quality gate       | `bun run quality`                                      | Exit 0; all correctness tests and existing coverage gates pass                       |
| Build                           | `bun run build`                                        | Exit 0; `dist/index.js` and `dist/index.d.ts` produced                               |
| Scope review                    | `git diff --check` and `git status --short`            | No whitespace errors; changes limited to allowed files and this plan's index row     |

`quality` runs lint, format checking, all three typechecks, and coverage-gated Vitest. `build` runs tsdown. These last two commands are executor verification gates, not commands the read-only advisor ran. Build artifacts belong in ignored `dist/`; remove only temporary artifacts created by your own run if necessary. Never run `quality:fix` or a repository-wide formatter; format only files you changed.

## Scope

Only these files may be changed or created:

- `README.md`
- `docs/TECHNICAL.md`
- `STATUS.md`
- `test/runs/module-composition.test.ts`
- `plans/README.md` — this plan's status row and completion evidence only.

Every other file is out of scope. Do not change versions, runtime dependencies, lockfiles, public exports, or unrelated lifecycle behavior. A listed configuration file may change only as specifically required below.

## Git workflow

Use an isolated branch `codex/008-qualify-override-cycle-guarantees`. Preserve user changes. Do not commit, push, merge, publish, create issues, or open a PR without operator instructions. If asked to commit, use concise conventional messages consistent with repository history, such as `fix: preserve namespace alternatives` or `docs: clarify factory disposal ownership`.

## Steps

### Step 1: Pin the supported public runtime boundary

Add a test group named `typed override cycles` in `test/runs/module-composition.test.ts`. Build the cast-free sync example above and assert `CircularDependencyError`; dispose the app in cleanup. Add an async equivalent with `singleAsync`/`withAsync`, await the rejection, and bound its test timeout to catch hangs. Add a positive override resolving an independent other entry to show that such resolvers remain supported.

These are characterization tests, not a red phase: current correct runtime behavior should already pass. Import public `CircularDependencyError` and composition APIs from `../../src`; do not use the raw engine shim or type assertions to create the cycle.

**Verify:** `bun run typecheck:all` and `bun run test -- test/runs/module-composition.test.ts -t 'typed override cycles'` → exit 0 on the current implementation.

### Step 2: Qualify ordinary construction separately from rewiring

Update README's composition rationale, guardrails, circular-dependencies section, and override section where their wording implies universal typed acyclicity. State that ordinary module construction exposes only earlier own entries, while overrides can introduce cycles by resolving other entries that lead back to the replacement. Those cycles are detected at runtime as `CircularDependencyError` even without casts or deep imports.

Update TECHNICAL.md's cycle heading/discussion, runtime-backstop summary, and comparison table if necessary. Preserve the distinction between cross-module static uses construction and entry-level provider acquisition after rewiring. Do not promise that all possible application-level recursion can be detected; this is DI resolution-cycle detection.

Update current composition semantics and deferred-note summaries in STATUS.md that repeat the unrestricted claim. Leave historical release version/results untouched. The conservative async acquisition policy remains intentional and should not be described as awaited-promise-only detection.

**Verify:** `rg -n 'cycle|acyclic|unwritable|unrepresentable|override' README.md docs/TECHNICAL.md STATUS.md` → every broad acyclicity claim is scoped to ordinary construction or accompanied by the explicit override exception. `bun run format` → exit 0. This search is a review inventory, not proof that keyword presence alone makes the prose correct.

### Step 3: Verify documentation against the executable examples

Ensure the prose names the public error and describes exactly the sync/async test cases. Keep the existing override feature and all type constraints unchanged. Do not add a compile-time ban on reaching later entries or modify wait-graph behavior to make the documentation true.

**Verify:** `bun run quality` and `bun run build` → exit 0; `git diff --check` → exit 0.

## Test plan

- Fully typed synchronous override introduces base → derived → base and throws `CircularDependencyError`.
- Async equivalent rejects with that error and does not hang.
- Noncyclic other-entry override remains valid and resolves the intended value.
- Compile-time gate checks that examples need no casts, any, or ignore directives.
- Existing raw-engine concurrent cycle and conservative-acquisition tests remain untouched and pass in full quality.

## Done criteria

- [ ] Three public characterization cases pass: sync cycle, async cycle, and noncyclic other-entry override.
- [ ] Public documentation explicitly says typed overrides can introduce runtime-detected cycles.
- [ ] No runtime implementation, public override restriction, or wait-graph policy change.
- [ ] Current STATUS summary agrees with README and TECHNICAL.md without rewriting historical results.
- [ ] `bun run test -- test/runs/module-composition.test.ts` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 with no weakened checks.
- [ ] `git diff --check` exits 0; changed files stay within Scope.
- [ ] Update `plans/README.md` with DONE plus commands/results, or BLOCKED with a concrete explanation. Do not claim unrun compatibility checks passed.

## STOP conditions

- Current-state signatures/behavior have drifted, including prerequisites, and have not been reconciled into the plan.
- Required toolchains/dependencies are unavailable; do not silently upgrade packages or edit the lockfile.
- A gate fails twice after reasonable correction or the solution requires out-of-scope changes.
- The cast-free examples do not typecheck after prerequisite changes; reconcile the supported override contract rather than adding casts.
- The examples fail to produce the documented framework error or hang; report the newly observed runtime defect instead of changing expected results.
- A proposed correction bans currently supported other-entry overrides or changes cycle detection.

## Maintenance notes

Future claims about compile-time guarantees must account for every public rewiring API, not only the ordinary builder. Keep these public tests alongside override tests so documentation assertions are grounded in a maintained example. Optional future earlier-entry-only override APIs require a separate design decision.
