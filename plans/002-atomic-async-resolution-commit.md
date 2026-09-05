# Plan 002: Make async cache commit and disposal registration atomic with lifecycle validation

> **Executor instructions:** Read this entire plan before editing. Follow the steps and verification gates; stop on the conditions below. This is an implementation handoff, not authorization to publish, push, or merge. Update only your status row in `plans/README.md` when done, unless your reviewer owns that index.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- src/container/resolution-cache.ts src/container/container.ts src/container/resolution-host.ts test/runs/concurrency.test.ts test/runs/module-composition.test.ts` and `git status --short`. Compare the excerpts below against the live code, including uncommitted changes. A changed line number alone is harmless; changed behavior or signatures require plan reconciliation before implementation. Files newly created by this plan must not already contain unrelated work.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED
- **Depends on:** Plan 001 for sequencing of shared lifecycle code. Reconcile changed disposal excerpts before starting; this defect exists independently.
- **Category:** bug
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #2

## Why this matters

An async provider's guard can succeed, then container disposal can begin before the value is cached and its disposer registered. Disposal waits for the guard promise rather than the complete cache-promotion operation and can miss that resource. A public-API reproduction returns a resource and leaves its cleanup counter at zero after awaited root disposal, violating explicit teardown-race safety.

## Current state

Repository: `/Users/erolyildiz/Projects/terrain`. All paths below are relative to its root, so an isolated checkout can use the same commands. Terrain is the ESM-only `terrain-di` TypeScript library: named modules compose into a fixed graph; the public entrypoint is `src/index.ts`. The token engine under `src/container/` is internal. There are no runtime dependencies. Do not add decorators, runtime registration, public tokens, or hot-swap behavior.

`src/container/resolution-cache.ts:69`:

```ts
let promise: Promise<T>;
promise = this.guard({
  token: token,
  build: () => this.host.invokeProviderAsync(definition, chain),
  isStale: () => resolutionPromises.get(token) !== promise,
  dispose: definition.dispose,
});
this.resolutionFrameByPromise.set(promise, ownFrame);
if (buildWaiter) this.scheduleWaitRemoval(buildWaiter, ownFrame, promise);
resolutionPromises.set(token, promise);

const settledResolution = await promise.then(
  (value) => ({ ok: true as const, value }),
  (error) => ({ ok: false as const, error }),
);

if (settledResolution.ok) {
  instances.set(token, settledResolution.value);
  if (definition.dispose) {
    this.host.trackDisposable(token, settledResolution.value, definition.dispose);
  }
  resolutionPromises.delete(token);
  return settledResolution.value;
}
if (resolutionPromises.get(token) === promise) resolutionPromises.delete(token);
throw settledResolution.error;
```

`src/container/resolution-cache.ts:181`:

```ts
let instance: T;
try {
  instance = await build();
} catch (error) {
  throw this.host.wrapProviderError(token, error);
}
if (this.host.isTreeDisposed() || this.host.isUnloading(token) || isStale()) {
  await this.disposeOrphan(instance, dispose);
  throw new DisposedContainerError();
}
return instance;
```

`src/container/container.ts:618`:

```ts
for (const resolutionPromise of this.resolutionCache.allPendingResolutionPromises()) {
  try {
    await resolutionPromise;
  } catch {
    /* orphaned resolution */
  }
}
this.resolutionCache.clearResolutionPromises();

await this.disposables.disposeReverse({ onError: (e) => errors.push(e) });

this.resolutionCache.clearInstances();
```

`docs/TECHNICAL.md:128` requires late resolutions to be disposed instead of leaked. `ResolutionHost` delegates lifecycle checks, disposal registration, provider invocation, and orphan-error observation to the container. `resolveCachedAsync` owns singleton/scoped cache and promise state; `resolveFactoryAsync` is caller-owned after successful return and must not become tracked as a normal disposable.

The wait graph intentionally treats every provider `getAsync` as dependency acquisition, even if its promise is ignored. Its frame registration must remain visible before a descendant can coalesce; do not change that conservative policy.

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

| Purpose                         | Command                                                                              | Expected result                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Focused verification            | `bun run test -- test/runs/concurrency.test.ts test/runs/module-composition.test.ts` | Exit 0 for the completed plan; intentional baseline failures are identified in Steps |
| Source, test, and example types | `bun run typecheck:all`                                                              | Exit 0, no diagnostics                                                               |
| Lint                            | `bun run lint`                                                                       | Exit 0; no new warnings                                                              |
| Format check                    | `bun run format`                                                                     | Exit 0                                                                               |
| Full release-quality gate       | `bun run quality`                                                                    | Exit 0; all correctness tests and existing coverage gates pass                       |
| Build                           | `bun run build`                                                                      | Exit 0; `dist/index.js` and `dist/index.d.ts` produced                               |
| Scope review                    | `git diff --check` and `git status --short`                                          | No whitespace errors; changes limited to allowed files and this plan's index row     |

`quality` runs lint, format checking, all three typechecks, and coverage-gated Vitest. `build` runs tsdown. These last two commands are executor verification gates, not commands the read-only advisor ran. Build artifacts belong in ignored `dist/`; remove only temporary artifacts created by your own run if necessary. Never run `quality:fix` or a repository-wide formatter; format only files you changed.

## Scope

**Only these files may be changed or created:**

- `src/container/resolution-cache.ts`
- `src/container/container.ts`
- `src/container/resolution-host.ts`
- `test/runs/concurrency.test.ts`
- `test/runs/module-composition.test.ts`
- `plans/README.md` — only this plan's status row and completion evidence.

Every other file is out of scope. In particular, do not update versions, dependencies, lockfiles, exports, or engine/public behavior beyond the task described here unless specifically listed and required by a step.

## Git workflow

Use an isolated branch named `codex/002-atomic-async-resolution-commit`. Preserve any existing user changes. Do not commit, push, merge, publish a package, create an issue, or open a PR without operator instructions. If a commit is requested, match the repository's concise conventional style, e.g. `fix: preserve async resource disposal` or `test: verify package consumers`.

## Steps

### Step 1: Add the exact settlement-boundary reproduction

Add a public test named `async commit is atomic with disposal` in `test/runs/module-composition.test.ts`. Use an explicitly typed deferred promise, not sleeps:

```ts
let release!: (value: object) => void;
const gate = new Promise<object>((resolve) => {
  release = resolve;
});
let cleaned = 0;
const M = createModule("M", (m) =>
  m.singleAsync("resource", () => gate, {
    dispose: () => {
      cleaned += 1;
    },
  }),
);
const app = createContainer({ parts: [M] });
const pending = app.M.resource();
const outcome = pending.then(
  (value) => ({ status: "fulfilled" as const, value }),
  (error: unknown) => ({ status: "rejected" as const, error }),
);
const disposing = gate.then(() => app.dispose());
release({});
await disposing;
await outcome;
expect(cleaned).toBe(1);
```

The audited implementation produces `cleaned === 0`. Do not require an arbitrary promise winner: if full commit completed before teardown, fulfillment is valid and normal disposal must run; if teardown won before commit, resolution must reject with `DisposedContainerError` and orphan cleanup must finish. Tests must pin each side with a deterministic scheduling setup and always assert exactly-once cleanup.

**Verify:** `bun run test -- test/runs/module-composition.test.ts -t 'async commit is atomic with disposal'` → fails on cleanup count at baseline. `bun run typecheck:all` → exit 0.

### Step 2: Make the tracked operation include the full commit

Refactor cached async resolution so the success continuation checks tree disposal, unloading, and promise identity immediately before synchronously publishing both the instance and its disposal record. No `await`, `.then` boundary, or user callback may intervene between validation and those two publications. If validation loses, await orphan disposal and reject without publishing.

Store a pending promise representing this entire operation, not only the earlier provider guard. Coalescers must share that result; teardown must await it. Remove the pending entry only if it still points to this operation. Preserve the frame association and build/coalesced dependency edges throughout the correct pending lifetime, including rejection cleanup. Preserve provider-error wrapping and observational `onDisposeError` behavior.

Avoid independently patching disposal with an extra arbitrary microtask delay or a second registry sweep; fix ownership at the commit boundary. Share helpers with factories only if caller-owned successful factory results remain untracked.

**Verify:** `bun run test -- test/runs/concurrency.test.ts test/runs/async.test.ts test/runs/disposal.test.ts test/runs/module-composition.test.ts` → exit 0, exact race regression included. `bun run typecheck:all` → exit 0.

### Step 3: Exercise commit winners, losers, and coalescers

Complete the matrix below. Use explicit deferred gates to prove which lifecycle transition happened first. Include the existing wait-graph tests as a guard against dropping or retaining dependency edges incorrectly. Do not weaken error or exactly-once assertions to accept a resource leak.

**Verify:** `bun run quality` and `bun run build` → exit 0; `git diff --check` → exit 0.

## Test plan

- Root singleton and child scoped cached async resources at the settlement boundary.
- Several coalescers: one provider execution, one cleanup record; all callers share the winning resolution outcome.
- Teardown starts before provider release: `DisposedContainerError`, orphan cleanup completed before teardown is considered complete.
- Resolution completes fully before teardown: returned resource is later disposed exactly once.
- Orphan disposer rejects: hook observes that failure without replacing the lifecycle rejection; normal disposer failures still aggregate through `dispose()`.
- Raw-engine unload uses the same full pending-operation lifetime and cannot leave an evicted cache entry behind.
- Provider rejection can be retried normally without a stale pending entry.
- Existing concurrent cycle tests and factory orphan tests remain green. Use existing `test/runs/concurrency.test.ts:8` as assertion style, but replace sleeps with deferred gates for new race tests.

## Done criteria

- [ ] The exact public settlement-boundary regression disposes its resource once.
- [ ] No continuation can publish an instance after its lifecycle validation has become stale.
- [ ] Container teardown awaits the operation that owns cache/disposal publication, including coalescers.
- [ ] Tests distinguish normal factory ownership from orphan cleanup.
- [ ] `bun run test -- test/runs/concurrency.test.ts test/runs/module-composition.test.ts` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 without lowered thresholds or ignored regressions.
- [ ] `git diff --check` exits 0 and changed files match Scope.
- [ ] Update `plans/README.md` with DONE and a compact record of commands/results, or BLOCKED with a concrete reason. Do not mark DONE if a required runtime/toolchain check could not run.

## STOP conditions

- Current-state behavior/signatures differ from these excerpts, except a prerequisite change whose effect has been reviewed and reconciled into this plan.
- A verification gate fails twice after a reasonable correction, or a required dependency/toolchain is unavailable.
- The work requires an out-of-scope source/configuration change, weaker tests/types, new runtime dependencies, or public behavior not authorized below.
- The proposed operation graph makes teardown await itself or changes the conservative wait-graph contract.
- Correctness requires edits to `wait-for-graph.ts` beyond this plan's scope; report the required extension rather than redesigning cycle detection.
- A refactor relies on timing delays, cached-promise casts that conceal incompatible values, or best-effort cleanup after disposal has already returned.

## Maintenance notes

The important invariant is atomic validation plus publication, not any particular count of microtasks. Review both cache success and failure paths and confirm every pending promise represents its resource-ownership work. Future unload/coalescing changes must preserve that same invariant.
