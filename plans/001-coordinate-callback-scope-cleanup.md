# Plan 001: Coordinate callback-scope cleanup without removing lifecycle exclusivity

> **Executor instructions:** Read this entire plan before editing. Follow the steps and verification gates; stop on the conditions below. This is an implementation handoff, not authorization to publish, push, or merge. Update only your status row in `plans/README.md` when done, unless your reviewer owns that index.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- src/container/container.ts test/runs/scopes.test.ts test/runs/lifecycle.test.ts test/runs/module-composition.test.ts` and `git status --short`. Compare the excerpts below against the live code, including uncommitted changes. A changed line number alone is harmless; changed behavior or signatures require plan reconciliation before implementation. Files newly created by this plan must not already contain unrelated work.

## Status

- **Priority:** P1
- **Effort:** M
- **Risk:** MED
- **Depends on:** None. Execute before plan 002; do not edit shared lifecycle code concurrently.
- **Category:** bug
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #1

## Why this matters

Two simultaneous public `app.scope(callback)` calls can complete their bodies successfully, but one cleanup rejects with `LifecycleOperationError` and leaves its resource alive until root disposal. This is a confirmed conflict between two documented contracts, not proof that the lifecycle lock itself is a mistake. Preserve intentional fail-fast explicit lifecycle operations while making cleanup of ordinary sibling callback scopes reliable.

## Current state

Repository: `/Users/erolyildiz/Projects/terrain`. All paths below are relative to its root, so an isolated checkout can use the same commands. Terrain is the ESM-only `terrain-di` TypeScript library: named modules compose into a fixed graph; the public entrypoint is `src/index.ts`. The token engine under `src/container/` is internal. There are no runtime dependencies. Do not add decorators, runtime registration, public tokens, or hot-swap behavior.

`src/container/container.ts:116`:

```ts
  // Acquire the tree-wide lifecycle lock (coordinated on the root). Returns the
  // root so the caller can release exactly what it acquired.
  private beginTreeLifecycle(): Container {
    const root = this.root();
    this.assertTreeUsable();
    if (root.lifecycleBusy) throw new LifecycleOperationError();
    root.lifecycleBusy = true;
    return root;
  }
```

`src/container/container.ts:253`:

```ts
  // Run fn with a fresh scope that is always disposed afterwards. Preserves the
  // body error if disposal also fails.
  async withScope<T>(fn: (scope: Container) => T | Promise<T>): Promise<T> {
    const scope = this.createScope();

    let result: T | undefined;
    let bodyError: unknown;
    let failed = false;

    try {
      result = await fn(scope);
    } catch (error) {
      bodyError = error;
      failed = true;
    }

    try {
      await scope.dispose();
    } catch (disposeError) {
      if (failed) {
        throw new AggregateError(flattenErrors([bodyError, disposeError]), "Scope body and scope disposal both failed");
      }
      throw disposeError;
    }

    if (failed) throw bodyError;
    return result as T;
  }
```

`test/runs/scopes.test.ts:20`:

```ts
it("withScope disposes its scope afterwards", async () => {
  const T = createSyncToken<{ dispose(): void }>("ws");
  let disposed = 0;
  const root = new Container();
  root.load(
    createModule((m) => m.scoped(T, () => ({ dispose: () => (disposed += 1) }), { dispose: (x) => x.dispose() })),
  );
  await root.withScope(async (scope) => {
    scope.get(T);
  });
  expect(disposed).toBe(1);
});
```

Design constraints: `docs/TECHNICAL.md:131` says "load/unload/dispose are mutually exclusive across a container tree"; `README.md:313` promises callback scopes "always disposes it". Existing `test/runs/lifecycle.test.ts:276` deliberately expects explicit disposal during unload to reject. `src/module-composition/container-views.ts:14` delegates callback scopes to `Container.withScope`; the ownership/coordination fix belongs in the engine, not in separate public wrappers.

A deterministic reproduction creates a sync scoped resource with a counted disposer and awaits `Promise.allSettled([app.scope(s => s.M.resource()), app.scope(s => s.M.resource())])`. Audited result: one fulfilled callback, one `LifecycleOperationError`, and one cleanup. Only a later root disposal performs cleanup number two.

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

| Purpose                         | Command                                                                                                     | Expected result                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Focused verification            | `bun run test -- test/runs/scopes.test.ts test/runs/lifecycle.test.ts test/runs/module-composition.test.ts` | Exit 0 for the completed plan; intentional baseline failures are identified in Steps |
| Source, test, and example types | `bun run typecheck:all`                                                                                     | Exit 0, no diagnostics                                                               |
| Lint                            | `bun run lint`                                                                                              | Exit 0; no new warnings                                                              |
| Format check                    | `bun run format`                                                                                            | Exit 0                                                                               |
| Full release-quality gate       | `bun run quality`                                                                                           | Exit 0; all correctness tests and existing coverage gates pass                       |
| Build                           | `bun run build`                                                                                             | Exit 0; `dist/index.js` and `dist/index.d.ts` produced                               |
| Scope review                    | `git diff --check` and `git status --short`                                                                 | No whitespace errors; changes limited to allowed files and this plan's index row     |

`quality` runs lint, format checking, all three typechecks, and coverage-gated Vitest. `build` runs tsdown. These last two commands are executor verification gates, not commands the read-only advisor ran. Build artifacts belong in ignored `dist/`; remove only temporary artifacts created by your own run if necessary. Never run `quality:fix` or a repository-wide formatter; format only files you changed.

## Scope

**Only these files may be changed or created:**

- `src/container/container.ts`
- `test/runs/scopes.test.ts`
- `test/runs/lifecycle.test.ts`
- `test/runs/module-composition.test.ts`
- `plans/README.md` — only this plan's status row and completion evidence.

Every other file is out of scope. In particular, do not update versions, dependencies, lockfiles, exports, or engine/public behavior beyond the task described here unless specifically listed and required by a step.

## Git workflow

Use an isolated branch named `codex/001-coordinate-callback-scope-cleanup`. Preserve any existing user changes. Do not commit, push, merge, publish a package, create an issue, or open a PR without operator instructions. If a commit is requested, match the repository's concise conventional style, e.g. `fix: preserve async resource disposal` or `test: verify package consumers`.

## Steps

### Step 1: Establish the conflicting contracts with deterministic regressions

In `test/runs/module-composition.test.ts`, add a group named `callback scope cleanup coordination`. Use public `createModule`/`createContainer`, a `scoped("resource", ...)` entry, and two concurrent callback scopes. Assert both callbacks return their distinct body results and both resource identities have been disposed before either combined result is accepted. In the baseline reproduction, assert a total cleanup count of 2 before root disposal; also assert root disposal does not add cleanup calls. Attach rejection handlers immediately to avoid unhandled-rejection noise.

Add controlled-promise tests for asynchronous disposers that prove at most one disposer is active, without real timers. Retain existing tests of explicit lifecycle rejection unchanged.

**Verify:** `bun run test -- test/runs/module-composition.test.ts -t 'callback scope cleanup coordination'` → fails on the current implementation because sibling cleanup is rejected, not because of setup or type errors. `bun run typecheck:all` → exit 0. This is the intentional red phase.

### Step 2: Define and implement narrowly scoped automatic-cleanup coordination

Keep `beginTreeLifecycle` fail-fast for explicit load/unload/dispose calls. Add internal coordination for callback-scope finalizers at the tree root, with per-scope completion results. Finalizers must execute serially, release coordination in `finally`, continue after another finalizer fails, and preserve each callback's own body/disposal errors. Do not resolve a callback promise until its accepted cleanup has completed.

Before implementing the coordinator, trace these cases in the code: sibling finalizers, normal nested callbacks whose child finishes before the parent body, a callback returning while an explicit unload owns the lock, and a disposer that awaits another callback scope. Do not use an unconditional promise-tail queue: reentrant disposal can await work queued behind itself and deadlock. The authorized minimum behavioral change is coordination between ordinary callback finalizers; explicit lifecycle operations keep their current rejection policy. If distinguishing safe waiting from reentrancy requires a new public policy or ambient/runtime-specific async context, STOP with the regression tests and a proposed design. Do not silently reject ordinary new requests, remove the lock, busy-poll, or broaden lifecycle serialization.

Where existing explicit operations still reject cleanup, preserve the original error and attached scope ownership for later root cleanup; do not claim that such explicitly conflicting operations now succeed. Normal callback nesting must remain supported.

**Verify:** `bun run test -- test/runs/scopes.test.ts test/runs/lifecycle.test.ts test/runs/module-composition.test.ts` → exit 0; new sibling tests pass and original lock-rejection tests remain unchanged and pass.

### Step 3: Verify error isolation, nesting, and disposal completion

Add the remaining Test plan cases, including an asynchronous disposer failure in one sibling while another succeeds. Assert the second finalizer still runs and each callback receives only its own failures. Add a bounded reentrancy characterization test before declaring the coordinator safe; the outcome may remain a framework rejection, but must not become a hang. If safety depends on changing that existing policy, STOP for review. Use Vitest timeouts only as hang guards, not to schedule interleavings.

**Verify:** `bun run quality` and `bun run build` → exit 0. `git diff --check` → exit 0.

## Test plan

- Two and several concurrent callback scopes with synchronous bodies/disposers: every instance disposed once, every body result returned.
- Async disposer gates: later cleanup waits, maximum concurrent disposer count is 1, callback promises remain pending until their cleanup completes.
- One disposer throws: sibling cleanup still runs; no sticky lock or poisoned queue on a subsequent scope.
- Body error plus disposal error: preserve both using the existing flattened `AggregateError` pattern in `test/runs/scopes.test.ts`.
- Nested callback scopes complete; reverse disposal order remains local to each scope.
- Existing explicit load/unload/dispose conflict tests pass without changing their expected errors.
- Reentrant callback creation from a disposer cannot introduce a deadlock; report a design blocker if the available runtime cannot distinguish that case safely.

## Done criteria

- [ ] The public two-scope regression returns both body values with cleanup count exactly 2 before root disposal.
- [ ] Gated async disposal proves no overlap and no early callback completion.
- [ ] All existing explicit lifecycle rejection expectations remain intact.
- [ ] `bun run test -- test/runs/scopes.test.ts test/runs/lifecycle.test.ts test/runs/module-composition.test.ts` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 without lowered thresholds or ignored regressions.
- [ ] `git diff --check` exits 0 and changed files match Scope.
- [ ] Update `plans/README.md` with DONE and a compact record of commands/results, or BLOCKED with a concrete reason. Do not mark DONE if a required runtime/toolchain check could not run.

## STOP conditions

- Current-state behavior/signatures differ from these excerpts, except a prerequisite change whose effect has been reviewed and reconciled into this plan.
- A verification gate fails twice after a reasonable correction, or a required dependency/toolchain is unavailable.
- The work requires an out-of-scope source/configuration change, weaker tests/types, new runtime dependencies, or public behavior not authorized below.
- Fixing sibling cleanup requires removing `LifecycleOperationError`, making explicit operations wait, or rejecting all new requests whenever another request is cleaning up.
- A queued finalizer can be awaited by the disposer that currently holds the lock, and you cannot prevent the resulting deadlock without a new policy.
- Making a guarantee for callbacks racing explicit unload/root shutdown requires an API decision beyond ordinary sibling callback coordination.

## Maintenance notes

Review lifecycle entry/exit and error ownership as one unit. Exclusive operations are intentional. This plan resolves ordinary callback concurrency; it must not pretend to establish a new universal reentrancy policy. Plan 002 touches async cache completion and disposal waiting next, so reconcile its excerpts after this plan lands.
