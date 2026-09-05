# Plan 004: Represent conditional module alternatives without inventing namespaces

> **Executor instructions:** Read the entire plan, follow the steps and verification gates, and stop on the conditions below. Update your status row in `plans/README.md` when done unless a reviewer maintains it. This handoff does not authorize publishing, pushing, or merging.
>
> **Drift check — run first:** `git diff --stat 801c2b0..HEAD -- src/module-composition/types.ts test/runs/types.test.ts test/runs/module-composition.test.ts` and `git status --short`. Compare excerpts against live code and any uncommitted changes. Line-number movement alone is harmless; changed behavior/signatures require reconciliation. Do not overwrite unrelated files at newly proposed paths.

## Status

- **Priority:** P2
- **Effort:** M
- **Risk:** MED
- **Depends on:** None semantically. Execute before plan 005 because both change types.ts and type tests.
- **Category:** bug
- **Planned at:** commit `801c2b0`, 2026-09-05
- **Audit finding:** #4

## Why this matters

`createContainer({ parts: [condition ? A : B] })` currently advertises both A and B as definitely present even though runtime construction receives only one. The same defect affects conditional `uses` entries inside providers. This is confirmed type unsoundness; no documented intentional exception was found. The fix should represent uncertainty in types while retaining ordinary concrete tuple inference and the unchanged static runtime graph.

## Current state

Repository: `/Users/erolyildiz/Projects/terrain`; all paths are repository-relative so isolated checkouts can run the same commands. Terrain is an ESM-only TypeScript DI library published as `terrain-di`, with no runtime dependencies. `src/index.ts` exposes named static composition and errors; the token engine is internal. Preserve static composition, explicit namespace exposure, typed sync/async separation, and explicit opt-in cleanup.

`src/module-composition/types.ts:54`:

```ts
// ── namespaces ─────────────────────────────────────────────────────────────
type NamespaceOf<Module> =
  Module extends ComposedModule<infer ModuleName, infer ModuleEntries>
    ? { readonly [K in ModuleName]: ModuleAccessorsOf<ModuleEntries> }
    : never;

type SyncNamespaceOf<Module> =
  Module extends ComposedModule<infer ModuleName, infer ModuleEntries>
    ? { readonly [K in ModuleName]: SyncModuleAccessorsOf<ModuleEntries> }
    : never;

type AsyncNamespaceOf<Module> =
  Module extends ComposedModule<infer ModuleName, infer ModuleEntries>
    ? { readonly [K in ModuleName]: AsyncModuleAccessorsOf<ModuleEntries> }
    : never;

// ── import namespaces ───────────────────────────────────────────────────────
type ImportNamespaces<Uses extends UsedModules> = Uses extends readonly []
  ? {}
  : UnionToIntersection<NamespaceOf<Uses[number]>>;

type SyncImportNamespaces<Uses extends UsedModules> = Uses extends readonly []
  ? {}
  : UnionToIntersection<SyncNamespaceOf<Uses[number]>>;
```

`src/module-composition/types.ts:192`:

```ts
/** Input to createContainer: the modules/overrides to compose, plus optional
 *  root ContainerOptions (e.g. onDisposeError). Scopes inherit these options. */
export interface ContainerConfig<Parts extends readonly ContainerPart[]> {
  readonly parts: Parts;
  readonly options?: ContainerOptions;
}

export type Namespaces<Parts extends readonly ContainerPart[]> = UnionToIntersection<NamespaceOf<Parts[number]>>;

/** No-arg: a child scope view you dispose() yourself. Callback: the scope is
 *  created, handed to the work, and ALWAYS disposed afterwards (the engine's
 *  withScope semantics — body errors preserved, both-fail aggregated). */
export interface ScopeMethod<Parts extends readonly ContainerPart[]> {
  (): ScopeView<Parts>;
  <T>(work: (view: ScopeView<Parts>) => T | Promise<T>): Promise<T>;
}

export type ContainerView<Parts extends readonly ContainerPart[]> = Simplify<
  Namespaces<Parts> & {
    scope: ScopeMethod<Parts>;
    start(): Promise<void>;
    dispose(): Promise<void>;
  }
>;

export type ScopeView<Parts extends readonly ContainerPart[]> = Simplify<
  Namespaces<Parts> & {
    /** Scopes nest: a request scope can open transaction sub-scopes. */
    scope: ScopeMethod<Parts>;
    dispose(): Promise<void>;
  }
>;
```

`test/runs/types.test.ts:62`:

```ts
  it("createContainer accepts a config object and infers namespaces from parts", () => {
    const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => ({ info() {} })));

    const a = createContainer({ parts: [Infra] });
    expectTypeOf(a.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();

    const options: ContainerOptions = { onDisposeError() {} };
    const b = createContainer({ options: options, parts: [Infra] });
    expectTypeOf(b.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();

    const config: ContainerConfig<readonly [typeof Infra]> = { parts: [Infra] };
    const c = createContainer({ ...config });
    expectTypeOf(c.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();
```

`src/kernel/types.ts` defines `UnionToIntersection`; the problem is applying it to the union of all array element possibilities. That erases the distinction between multiple positions that are all present and alternatives within one position. `README.md:176` says only modules passed to `createContainer` receive public namespaces. Static composition means the graph is fixed after construction; choosing an input conditionally before construction does not constitute hot-swap.

Both calls below compile at baseline, even though one namespace is missing at runtime:

```ts
const A = createModule("A", (m) => m.single("a", () => 1));
const B = createModule("B", (m) => m.single("b", () => "b"));
const app = createContainer({ parts: [Math.random() < 0.5 ? A : B] });
app.A.a();
app.B.b();
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
- `test/runs/types.test.ts`
- `test/runs/module-composition.test.ts`
- `plans/README.md` — this plan's status row and completion evidence only.

Every other file is out of scope. Do not change versions, runtime dependencies, lockfiles, public exports, or unrelated lifecycle behavior. A listed configuration file may change only as specifically required below.

## Git workflow

Use an isolated branch `codex/004-preserve-conditional-module-types`. Preserve user changes. Do not commit, push, merge, publish, create issues, or open a PR without operator instructions. If asked to commit, use concise conventional messages consistent with repository history, such as `fix: preserve namespace alternatives` or `docs: clarify factory disposal ownership`.

## Steps

### Step 1: Pin concrete, alternative, and widened input contracts

In `test/runs/types.test.ts`, add a group named `conditional module namespaces`. Put calls expected to become invalid in a nonexecuted function with `@ts-expect-error`. Cover unconditional access to A/B for `[condition ? A : B]`, the corresponding sync and async provider `uses` variants, and widened arrays that can be empty. Add positive exact/not-any assertions for fixed `[A, B]`, empty parts, modules plus overrides, and an always-present module alongside an alternative.

**Verify:** `bun run typecheck:test` → baseline failures for unused `@ts-expect-error` on the unsound calls. Existing concrete positive assertions must still compile. `bun run test -- test/runs/types.test.ts` → exit 0 because negative examples do not execute.

### Step 2: Derive namespaces by tuple position, preserving alternatives

Add local private type helpers in `src/module-composition/types.ts`; do not change shared `UnionToIntersection` globally. For a concrete readonly tuple, recursively combine the namespace contribution of each tuple position by intersection, retaining a union within each position. Empty tuples contribute `{}` and override parts contribute `{}`. Distribute over alternatives deliberately, including unions of whole tuples, so absent alternatives remain absent rather than mandatory.

For widened arrays whose length is not known, no namespace is guaranteed present. Model possible namespaces as optional and retain the union of possible accessor shapes for each module name. Do not intersect incompatible entries from alternative same-named module objects into an impossible or overconfident value type. Keep this fallback conservative; do not assert array nonemptiness or invent guarantees from `Parts[number]`.

Apply the same positional derivation to full and sync-only imported namespaces. Preserve own-earlier entries and the sync resolver's exclusion of async entries. Public container/scope lifecycle methods must remain definite even when module namespaces are conditional. Do not alter runtime wiring or module identity rules.

**Verify:** `bun run typecheck:all` → exit 0, including positive and negative contracts. `bun run test -- test/runs/types.test.ts test/runs/module-composition.test.ts` → exit 0.

### Step 3: Prove narrowing and runtime parity

For a tuple conditional, verify that a property-presence check or narrowing the module choice before construction allows safe access without casts. For widened arrays, check a possible namespace for presence before use. Add one deterministic runtime test for each branch using the correctly narrowed public view; assert the selected namespace resolves and the other is absent. Add alternatives with the same module name but distinct return types and verify the exposed value remains a union, not a falsely definite constituent.

**Verify:** `bun run quality` and `bun run build` → exit 0. `git diff --check` → exit 0.

## Test plan

- Fixed heterogeneous tuples and explicitly annotated `ContainerConfig<readonly [typeof A, typeof B]>` preserve exact types.
- Empty tuples and override-only type contributions preserve lifecycle methods without fabricated namespaces; existing runtime invalid-override behavior remains unchanged.
- Conditional position, optional module via tuple alternative, and union of complete tuples do not guarantee absent namespaces.
- Widened arrays may be empty: namespaces require presence checks.
- Same-name alternatives preserve alternative value types rather than intersecting them unsafely.
- Sync providers cannot access async entries after the change; async providers retain both modes.
- No `any` leakage: pair positives with `.not.toBeAny()` as in `test/runs/types.test.ts`.
- New type tests are compile-time tests; do not replace them with runtime snapshots.

## Done criteria

- [ ] Both baseline unconditional alternative namespace calls are rejected by TypeScript.
- [ ] Fixed tuples keep existing exact inferred accessors and lifecycle methods.
- [ ] Conditional imports and widened arrays require sound narrowing.
- [ ] Runtime wiring implementation is unchanged.
- [ ] `bun run typecheck:all` exits 0.
- [ ] `bun run quality` and `bun run build` exit 0 with no weakened checks.
- [ ] `git diff --check` exits 0; changed files stay within Scope.
- [ ] Update `plans/README.md` with DONE plus commands/results, or BLOCKED with a concrete explanation. Do not claim unrun compatibility checks passed.

## STOP conditions

- Current-state signatures/behavior have drifted, including prerequisites, and have not been reconciled into the plan.
- Required toolchains/dependencies are unavailable; do not silently upgrade packages or edit the lockfile.
- A gate fails twice after reasonable correction or the solution requires out-of-scope changes.
- The only proposed fix rejects all valid concrete heterogeneous tuples or introduces `any`/blanket assertions.
- Preserving an existing public helper requires pretending a widened array is nonempty; report the incompatible contract instead.
- New recursive types cause excessive-instantiation diagnostics on existing examples or make the normal typecheck impractical.
- A fix requires changing module identity, runtime duplicate-name behavior, or public method names.

## Maintenance notes

TypeScript unions represent alternatives; intersections represent simultaneous guarantees. Review every future array-to-namespace transformation with conditional positions and possibly-empty arrays. Plan 005 changes override key inference next; preserve these new positives and negatives when reconciling its excerpts.
