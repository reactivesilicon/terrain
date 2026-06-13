# terrain — project status

> Working notes for the maintainers. Updated 2026-06-13, branch `leap-q1`.

## Where things stand

**`main`** holds **terrain v1.0.0** — the token-based API, released:

- npm package **`terrain-di`** (the bare name `terrain` is squatted); repo `reactivesilicon/terrain`. Verify publish state with `npm view terrain-di`.
- GitHub Actions CI runs `bun run quality` + build on every push/PR (Node 24 + bun pinned).
- Release notes for the v1.0.0 GitHub Release were drafted in-session; CHANGELOG.md was deliberately deleted — **GitHub Releases is the only changelog channel**.

**`leap-q1`** holds the **module-composition layer** (v2 candidate) under `src/module-composition/` (`composition.ts` runtime + `types.ts` type-level model + `wiring.ts` uses-graph rules; errors live in the shared `src/errors.ts`) — a typed facade over the unchanged v1 engine. The v1 public API is untouched and `src/module-composition` is not exported from `index.ts`.

## v1.0.0 (main) — what it is

- Object tokens (`createSyncToken`/`createAsyncToken`), branded interfaces, unexported impl classes, frozen, rich printing (`Token<sync #ab12cd>(name)`).
- **Compile-time sync/async split**: `get()` rejects `AsyncToken`, `getAsync()` rejects `Token`; runtime errors (`AsyncProviderError`/`SyncProviderError`) remain as backstops for untyped callers. `AnyToken` where mode doesn't matter.
- Modules via `createModule(setup)` (statement style, void callbacks); six builder methods with options: `{ dispose }` everywhere, `{ eager }` on singletons only (type-enforced via separate `SingletonDefinitionOptions`). The six methods are sugar over `ModuleBuilder.define(definition)` — the data-driven registration primitive. The `Definition` union itself encodes the eager rule (`LifetimeOptions`: `eager?: boolean` on singletons, `eager?: never` otherwise), and `define()` throws `InvalidDefinitionError` as the runtime backstop for untyped callers.
- **Explicit disposal only** — no `dispose()` duck-typing. Token-keyed disposal records (alias-safe). Reverse creation order.
- **Eager boot**: `{ eager: true }` + `await container.start()` (parallel, `AggregateError` on failures, idempotent, constructs at `start()` not `load()` so test overrides still work).
- **Unload safety**: construction-time `DependencyGraph` (token-level "who captured whom", lives on root); `unload` refuses live dependents (`DependentInstanceError`), conservative by design; edges purged on unload/override/scope-dispose. Module-identity ownership (`definitionOwners`): a stale module object can't evict its replacement (`ModuleOwnershipError`).
- Accessors: `container.accessors({ name: Token })` / `createAccessors` — typed lazy getters. The mechanism (`buildAccessorPrototype` + `instantiateAccessors` in `accessors.ts`: per-spec prototypes, lazy cached closures, destructuring-safe) is shared with the module-composition layer's namespaces — one accessor implementation for both APIs.
- Scoped-on-root is **legal and documented**: every container is a scope; root caches scoped instances until disposal.
- Engine concurrency invariants (tree lifecycle lock, in-flight orphaning, promise-identity guards) all preserved and fuzz-tested.

### v1 documented limitations (README "Known limitations")

1. **Coalesced async cycles deadlock** instead of throwing (cycle split across two concurrent `getAsync` chains). Future fix: wait-for graph. _(Note: inexpressible in the module-composition layer — see below.)_
2. Unload safety can't see references held by application code.
3. Dependent tracking is conservative (resolve == capture).

## Module-composition layer (leap-q1) — what it is

```ts
const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => new ConsoleLogger()));
const Data  = createModule("Data", { uses: [Infra] }, (m) =>
  m.single("userRepository", (r) => new InMemoryUserRepository(r.Infra.logger())));
const app = createContainer(Data, Infra);
app.Data.userRepository();             // typed, no tokens anywhere
await app.scope(async (req) => ...);   // auto-disposed request scope
```

- **No tokens, no type args**: names at registration are the handles; interfaces enter via provider return annotations. Tokens are minted internally (`"Module.entry"` descriptions) — the v1 engine does all real work. Registration constructs engine `Definition` records (`toEngineDefinition` → `ModuleBuilder.define`); there is no method-dispatch translation layer.
- **Chaining is the contract**: type accumulation rides each builder call's return (statement style is impossible — variable types can't evolve; documented).
- **One call shape everywhere**: `Module.entry()` — container view, scope views, and inside providers (own module under its own name; imports under theirs). `get/getAsync/has` were removed entirely.
- **Compile-time guarantees**: forward refs rejected → in-module cycles unwritable; `uses` requires existing values → cross-module cycles unwritable (v1's deadlock limitation can't be expressed); sync providers see only sync entries of imports; unknown names/namespaces are type errors.
- **Wiring is transitive, exposure is explicit**: `uses` deps auto-load; only modules passed to `createContainer` get namespaces. No transitive re-export → type-enforced layer isolation.
- **PascalCase module names enforced** (compile-time `PascalCase<Name>` + runtime regex): the view API is lowercase forever, so namespaces can never shadow `scope`/`start`/`dispose` — no reserved-word list. Entry names must be identifiers.
- **Version diamonds work and are tested**: A uses Core@v1, B uses Core@v2 — each importer's `r.Core` resolves to its own; only exposing both same-named modules conflicts.
- **Views are closed (decided 2026-06-13)**: no `container` escape hatch — tokens and the engine are internal currency, never on the public surface. Engine capabilities reach users only as typed view features; v1 and composed modules cannot share one container.
- **Internals are unreachable (2026-06-13)**: module/override internals live in module-scoped `WeakMap` registries, not on the objects — public objects are frozen `{ name, override }` / `{ name }`, so no JS caller can reach tokens, the engine module, or wiring state. `ForeignModuleError` is identity-based (presence in the registry), not shape-based — structural look-alikes are rejected.
- **Dual-mode `scope()`** on both views (callback form auto-disposes via engine `withScope`; scopes nest).
- **Perf**: namespaces are per-module prototypes with lazy-getter accessors (the shared `accessors.ts` machinery; cached closures, destructuring-safe) — `scope()` ≈ 571ns at 200 entries; factory resolution ≈ 310ns. Type-cost measured: ~300ms marginal tsc for a pathological 200-entry module (`bench/module-composition-type-bench.mjs`).
- All guards are `DIError` subclasses: `InvalidModuleNameError`, `InvalidEntryNameError`, `DuplicateEntryNameError`, `InvalidModuleUseError`, `ForeignModuleError`, `DuplicateModuleNameError`.
- Playground: `examples/module-composition.ts` (3-layer real-world shape). v1 playground: `examples/usage.ts`.

### Module-composition caveats (documented in composition.ts header)

- Go-to-definition on `r.Infra.logger` lands on a mapped type, not the provider.
- The chain is the contract: imperative registration via captured `m` exists at runtime, invisible to types.

## ✅ Overrides (the former gating gap) — SHIPPED 2026-06-12

Settled design (all four decisions made by the maintainer):

```ts
const FakeInfra = InfraModule.override((o) =>
  o
    .with("logger", (): Logger => silentLogger) // sync entries
    .withAsync("db", async () => fakeDb, { eager: true }),
); // async entries

const app = createContainer(DomainModule, FakeInfra); // overrides inline in the list
```

- **Derived anchor**: `Module.override()` — identity-based (original tokens reused), fully compile-checked: entry names, value types, and sync/async mode are constrained by the original (`@ts-expect-error`-pinned).
- **Inline passing**: overrides travel in `createContainer`'s variadic list (`ContainerPart = NamedModule | ModuleOverride`); they rewire but never expose namespaces.
- **Provider + options only**: lifetime is inherited from the original (tested for scoped/factory/async); `eager` in override options requires the original to be a singleton (runtime-guarded).
- **Loud on misuse**: unused override (target not in wiring), empty override, duplicate replacement, eager-on-non-single, unknown entry / mode mismatch (runtime backstops for JS) — all throw `DIError` subclasses.
- Works on transitive (unexposed) targets; overriding affects every importer — that's the point. Eager interplay: fake constructs at `start()`, real provider never runs (tested).
- Override providers may resolve the module's other entries (`r.Mod.base()`); the original's imports are reachable at runtime but not typed (fakes are expected to be self-contained — documented in `OverrideBuilder` JSDoc).

## Boundary of responsibilities (decided 2026-06-13)

Where functionality belongs — consult this before adding anything:

- **Engine** (`src/container/`, `src/module.ts`, `src/token.ts`, `src/types.ts`, `src/accessors.ts`): definitions and their registration primitive (`ModuleBuilder.define`), resolution, lifetimes, lifecycle (load/unload/override/dispose/start), concurrency invariants, accessor machinery. The engine `Module` is a flat, frozen bag of definitions and knows nothing about other modules — deliberately.
- **Module-composition layer** (`src/module-composition/`): names and module identity, composition (`uses` → transitive wiring in `wiring.ts`), typed provider resolvers and namespaces, views, override UX. Composition lives here, not in the engine, because it is a user-facing module concept whose typed half (namespace imports) can only exist at this layer.
- **Shared vocabulary is defined once, engine-side, and consumed upward**: errors (`errors.ts`), `Lifetimes`/`TokenModes`, resolver types, accessor primitives. The layer never re-declares an engine concept.

## Deferred / open (non-gating)

- Module-composition unload/hot-swap surface (or declare out of scope: `createContainer` is static composition by design).
- Module-name aliasing (only matters if a third-party module ecosystem emerges).
- v2 packaging decision: does the module-composition layer become the primary export of `terrain-di@2`? Final vocabulary: layer types take the `Module` name, kernel `Module` becomes `DefinitionSet` (settled direction, executed at the v2 boundary).
- v1 wait-for-graph fix for the coalesced-cycle deadlock (post-1.0, engine-level; moot for the module-composition layer).
- Possible future: `getOrNull`-style optional resolution (v1, additive).
- `createContainer(...parts)` cannot pass `ContainerOptions` (e.g. `onDisposeError`) — now the only unreachable engine capability; natural shape is a `createContainer(options, ...parts)` overload.
- Zero-cast accessor typing: brand `AccessorPrototype<Source>` + split builders so instantiating a full prototype over a plain `SyncResolver` is a compile error (design sketched in-session; deferred — eliminates the one capability cast in `accessors.ts` at the cost of brand-mint casts).
- Layer type vocabulary (`NamedModule` → `Module` etc.) — rides the v2 packaging item above.

## Engineering infrastructure (applies to both)

- **Tests**: vitest (migrated from custom harness, then from bun-test-incompatible assertions — `bun test` also passes but is NOT the configured runner; `bun run test` is). 171 tests across 16 files. Auto-discovery (`test/runs/*.test.ts`).
- **Coverage gates in `quality`**: statements 99 / branches 97 / functions 99 / **lines 100**. Deliberately-unreachable defensive code is marked `/* v8 ignore ... */` **with a reason** — each marker is an auditable exception (`grep -rn "v8 ignore" src/`).
- **Fuzzers** (both seeded via `TEST_SEED`, printed every run, replayable): `stress.test.ts` (engine: random load/unload/get/scope/dispose/start sequences) and `stress-module-composition.test.ts` (module-composition layer: random module graphs + ops incl. scope views interleaved with disposal). Four invariants: no use-after-dispose, no double-dispose, exactly-once teardown of cached instances, framework-errors-only. Fired-and-forgotten resolutions use a teardown-epoch to avoid a legitimate false positive (caller-side observation lag).
- **Benchmarks**: `bench/module-composition-type-bench.mjs` (tsc time vs module size).
- **Gate**: `bun run quality` = oxlint + oxfmt + tsc (src) + tsc (tests — note: this was once silently broken by an inherited `exclude`; fixed) + vitest with coverage. CI mirrors it exactly.

## Conventions to uphold (see `.agents/skills/code-clarity/SKILL.md`)

- "Names do the narration, comments do the proofs." Comments only for constraints code can't express; re-audit comments after every rename (census re-runs). No JSDoc by default.
- Read-aloud test for names; maps as `<values>By<key>`; booleans state exact facts; established vocabulary over invented synonyms.
- Compile-time enforcement first, runtime backstops for untyped callers — everywhere (token brands, eager placement, PascalCase names, builder splits).
- Fail loudly in the safe direction; conservative false positives over silent unsoundness.
- User's working preferences: discuss design/naming **before** changing code; present options with a recommendation; evaluations should be ranked findings with severity; every change lands with tests + gate green.

## Verification quickstart

```sh
bun run quality          # full gate (lint, format, both typechecks, coverage-gated tests)
bun examples/usage.ts    # v1 playground
bun examples/module-composition.ts    # module-composition playground
node bench/module-composition-type-bench.mjs
TEST_SEED=<n> bun run test   # replay a fuzzer run
```
