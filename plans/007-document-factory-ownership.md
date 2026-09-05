# Plan 007: Document caller ownership and the limits of factory disposer callbacks

> **Executor instructions:** Read the entire plan, follow the steps and verification gates, and stop on the conditions below. Update your status row in `plans/README.md` when done unless a reviewer maintains it. This handoff does not authorize publishing, pushing, or merging.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- README.md docs/TECHNICAL.md examples/public-api-usage.ts` and `git status --short`. Compare excerpts against live code and any uncommitted changes. Line-number movement alone is harmless; changed behavior/signatures require reconciliation. Do not overwrite unrelated files at newly proposed paths.

## Status

- **Priority:** P2
- **Effort:** S
- **Risk:** LOW
- **Depends on:** None semantically. Execute before plan 008 because both update README and TECHNICAL.md.
- **Category:** docs
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #7

## Why this matters

Public docs imply that registering `{ dispose }` causes every returned instance to be cleaned by container teardown. Successful factory instances are deliberately caller-owned, even with a registered callback. Clarify ownership and demonstrate explicit cleanup; do not change runtime tracking or reinterpret the intended behavior as a bug.

## Current state

Repository: `/Users/erolyildiz/Projects/terrain`; all paths are repository-relative so isolated checkouts can run the same commands. Terrain is an ESM-only TypeScript DI library published as `terrain-di`, with no runtime dependencies. `src/index.ts` exposes named static composition and errors; the token engine is internal. Preserve static composition, explicit namespace exposure, typed sync/async separation, and explicit opt-in cleanup.

`README.md:334`:

````text
## Disposal

Teardown is registered per entry with the `{ dispose }` option. The container disposes exactly what you registered — an instance that merely happens to have a `dispose()` method is never touched.

```ts
m.single("pool", () => new Pool(config), {
  dispose: (pool) => pool.end(),
});
````

This works with any teardown method name (`close`, `destroy`, `end`, …), and the disposer is typed to the entry's value. A disposer may be async even for a sync entry — disposal always runs in an async context:

```ts
type Disposer<T> = (instance: T) => void | Promise<void>;
```

```ts
await app.dispose();
```

Disposal runs in **reverse creation order**, so dependents are torn down before their dependencies. Disposing the container cascades to all of its scopes. `dispose()` is idempotent. If multiple disposers fail, the container throws an `AggregateError`.

````

`README.md:487`:

```text
```ts
m.single(name, provider, options?);       // options: { dispose?, eager? }
m.singleAsync(name, provider, options?);  // options: { dispose?, eager? }

m.factory(name, provider, options?);      // options: { dispose? }
m.factoryAsync(name, provider, options?); // options: { dispose? }

m.scoped(name, provider, options?);       // options: { dispose? }
m.scopedAsync(name, provider, options?);  // options: { dispose? }
````

`dispose: (instance: T) => void | Promise<void>` registers teardown; `eager: true` (singletons only) marks the entry for `start()`.

Sync methods (`single`, `factory`, `scoped`) receive a resolver with only sync entries. Async methods (`singleAsync`, `factoryAsync`, `scopedAsync`) receive a resolver with both sync and async entries. Accessors mirror the mode: sync entries are `() => T`; async entries are `() => Promise<T>`.

````

`test/runs/disposal.test.ts:41`:

```ts
  it("factory instances are not auto-tracked for disposal", async () => {
    const T = createSyncToken<{ dispose(): void }>("factoryDisp");
    let n = 0;
    const c = new Container();
    c.load(createModule((m) => m.factory(T, () => ({ dispose: () => (n += 1) }), { dispose: (x) => x.dispose() })));
    for (let i = 0; i < 500; i++) c.get(T);
    await c.dispose();
    expect(n, "factories are caller-owned").toBe(0);
  });
````

`examples/engine.ts:212` already states factories are caller-owned, but that internal example is not the public guide. `Container.resolveFactorySync` returns a successfully constructed value without `trackDisposable`; `ResolutionCache.resolveFactoryAsync` also returns successful values without registering normal disposal. Their registered callbacks are used for orphan cleanup when a result cannot be returned because teardown won. Normal successful factory ownership is distinct from singleton/scoped ownership.

Existing public example style (`examples/public-api-usage.ts:89`) uses `await app.scope((req) => { ... })`; its top-level `main().catch(...)` exits nonzero on failure. Keep this executable, dependency-free style.

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

| Purpose                         | Command                                                          | Expected result                                                                      |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Focused verification            | `bun run typecheck:examples && bun examples/public-api-usage.ts` | Exit 0 for the completed plan; intentional baseline failures are identified in Steps |
| Source, test, and example types | `bun run typecheck:all`                                          | Exit 0, no diagnostics                                                               |
| Lint                            | `bun run lint`                                                   | Exit 0; no new warnings                                                              |
| Format check                    | `bun run format`                                                 | Exit 0                                                                               |
| Full release-quality gate       | `bun run quality`                                                | Exit 0; all correctness tests and existing coverage gates pass                       |
| Build                           | `bun run build`                                                  | Exit 0; `dist/index.js` and `dist/index.d.ts` produced                               |
| Scope review                    | `git diff --check` and `git status --short`                      | No whitespace errors; changes limited to allowed files and this plan's index row     |

`quality` runs lint, format checking, all three typechecks, and coverage-gated Vitest. `build` runs tsdown. These last two commands are executor verification gates, not commands the read-only advisor ran. Build artifacts belong in ignored `dist/`; remove only temporary artifacts created by your own run if necessary. Never run `quality:fix` or a repository-wide formatter; format only files you changed.

## Scope

Only these files may be changed or created:

- `README.md`
- `docs/TECHNICAL.md`
- `examples/public-api-usage.ts`
- `plans/README.md` — this plan's status row and completion evidence only.

Every other file is out of scope. Do not change versions, runtime dependencies, lockfiles, public exports, or unrelated lifecycle behavior. A listed configuration file may change only as specifically required below.

## Git workflow

Use an isolated branch `codex/007-document-factory-ownership`. Preserve user changes. Do not commit, push, merge, publish, create issues, or open a PR without operator instructions. If asked to commit, use concise conventional messages consistent with repository history, such as `fix: preserve namespace alternatives` or `docs: clarify factory disposal ownership`.

## Steps

### Step 1: Document the lifecycle ownership distinction

Update the factory lifetime section, disposal section, and builder options reference in README. State explicitly that normally returned factory instances are caller-owned and root/scope disposal does not clean them, even when `{ dispose }` is configured. Singleton/scoped instances with registered callbacks are tracked. Describe factory callbacks as cleanup for orphaned construction results that cannot be returned after teardown, rather than normal factory-instance ownership.

Make the corresponding qualification in TECHNICAL.md's opt-in disposal decision and capabilities/guarantees where necessary. Preserve reverse-order tracked disposal and no duck-typing. Avoid claiming the library can clean resources a provider created but never returned because the provider threw.

**Verify:** `rg -n 'caller-owned|factory|orphan' README.md docs/TECHNICAL.md` → each document contains an explicit caller-owned statement; README ownership is visible in Lifetimes, Disposal, and API discussion. `bun run format` → exit 0.

### Step 2: Add a runnable public cleanup example

Extend `examples/public-api-usage.ts` with a small dependency-free factory resource using a close method and a counted close operation. Obtain the resource, use it, and close it in a caller-owned `try/finally`; dispose the container separately. Show that the caller closes it exactly once and container disposal does not duplicate that cleanup. Use a helper shared between the factory's optional orphan callback and the caller's cleanup if useful; do not expose internal definitions or tokens to invoke the registered disposer.

Include a concise README snippet matching that verified pattern, with enough setup to show ownership clearly. This is an executable documentation example, not a new runtime feature or a request-context redesign.

**Verify:** `bun run typecheck:examples && bun examples/public-api-usage.ts` → exit 0; the example asserts exactly one caller cleanup and no extra cleanup after container disposal. `bun run test -- test/runs/disposal.test.ts test/runs/concurrency.test.ts` → existing factory ownership and orphan tests pass unchanged.

### Step 3: Check all public disposal language for consistency

Read the edited disposal/lifetime/API sections together. Qualify blanket wording about registered entries where a reader might still infer normal factory tracking. Keep documentation concise and use the established words singleton, scoped, factory, disposer, orphan, and caller-owned. Do not alter the separate cycle-guarantee discussion handled by plan 008.

**Verify:** `bun run quality` and `bun run build` → exit 0; `git diff --check` → exit 0.

## Test plan

- Existing `test/runs/disposal.test.ts:41` remains the normal factory ownership regression and must not be changed.
- Existing async factory orphan test in `test/runs/concurrency.test.ts:31` remains unchanged.
- New executable public example demonstrates try/finally ownership and detects double cleanup without network/filesystem resources.
- No redundant runtime unit tests are needed for this documentation-only contract clarification; typecheck and execute the example.

## Done criteria

- [ ] README and TECHNICAL.md state normal factory caller ownership explicitly.
- [ ] README distinguishes successful return from orphan cleanup and avoids promising cleanup for partial failed provider construction.
- [ ] Public example typechecks, executes, and verifies exactly one caller cleanup.
- [ ] No runtime implementation or existing ownership assertions changed.
- [ ] `bun run typecheck:examples && bun examples/public-api-usage.ts` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 with no weakened checks.
- [ ] `git diff --check` exits 0; changed files stay within Scope.
- [ ] Update `plans/README.md` with DONE plus commands/results, or BLOCKED with a concrete explanation. Do not claim unrun compatibility checks passed.

## STOP conditions

- Current-state signatures/behavior have drifted, including prerequisites, and have not been reconciled into the plan.
- Required toolchains/dependencies are unavailable; do not silently upgrade packages or edit the lockfile.
- A gate fails twice after reasonable correction or the solution requires out-of-scope changes.
- Live factory code no longer matches the ownership test or orphan behavior described here; reconcile before writing definitive guidance.
- The example needs an internal container escape hatch, new public API, external service, or runtime dependency.
- Resolving wording appears to require changing factory tracking; that is outside this plan.

## Maintenance notes

Any future factory ownership change is behavioral and must update this documentation and ownership tests together. A registered callback and ownership transfer are separate concepts; keep that distinction visible at the API options reference where users are likely to infer otherwise.
