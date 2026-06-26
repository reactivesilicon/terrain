# terrain — project status

> Maintainer notes. Updated 2026-06-27, branch `main`.

## Where things stand

The latest published release is **terrain v1.2.0**

- npm package: **`terrain-di`**; the bare name `terrain` is squatted.
- GitHub Releases is the changelog channel; `CHANGELOG.md` was deliberately removed.
- `src/index.ts` exports `errors`, `module-composition`, and option/disposer types. Tokens, the raw `Container`, and the kernel `ModuleBuilder` are internal implementation details reachable only by deep imports.
- `README.md` documents the composition API as the primary API.

The 1.2.0 release carries:

- **Container options through the composition API**: `createContainer({ options, parts })` — a config object (the old variadic `createContainer(...parts)` is removed) that exposes `ContainerOptions.onDisposeError`; scopes inherit it.
- **Null-prototype accessor/namespace/view hardening** (bug fix): entry names like `source`/`accessorCache`/`toString` previously mis-resolved against internal or `Object.prototype` keys; accessor state is now Symbol-keyed and the namespace/view objects are null-prototype, so any identifier name is safe.
- **Relaxed module names**: any identifier except the reserved view methods `scope`/`start`/`dispose` (PascalCase is no longer required). Both module and entry names are now validated for identifier-ness at **compile time** (template-literal type guard) as well as at runtime.

## Public API now

```ts
const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => new ConsoleLogger()));
const Data = createModule("Data", { uses: [Infra] }, (m) =>
  m.single("userRepo", (r): UserRepo => new InMemoryUserRepo(r.Infra.logger(), new Map([["1", "Ada"]]))),
);
const UseCases = createModule("UseCases", { uses: [Data, Infra] }, (m) =>
  m.single("findUser", (r): FindUserUseCase => new FindUserUseCase(r.Data.userRepo(), r.Infra.logger())),
);

const app = createContainer({ parts: [UseCases] });
app.UseCases.findUser().execute("1");
await app.dispose();
```

- **Config-object composition**: `createContainer({ options?, parts })`. `parts` are the modules/overrides to expose+wire; `options` carries engine `ContainerOptions` (currently `onDisposeError`, observed for orphaned in-flight disposal only).
- **No public tokens**: entry names are the handles; internal tokens are minted as implementation currency.
- **Typed namespaces**: modules passed in `parts` are exposed as namespaces; transitive `uses` dependencies are wired but hidden unless passed explicitly.
- **Free identifier naming**: module names are any identifier except `scope`/`start`/`dispose`; entry names are any identifier. Reserved/non-identifier names fail at compile time, with runtime backstops for dynamic callers.
- **Chaining is the contract**: builder return types carry the entries registered so far. Imperative registration through a captured builder works at runtime but is invisible to the module type.
- **One call shape**: container views, scope views, and provider resolvers all resolve through module namespaces and entry accessors.
- **Sync/async split**: sync providers see only sync entries; async providers see sync and async entries. Async accessors return promises.
- **Lifetimes**: singleton, factory, scoped; sync and async forms for each.
- **Lifecycle**: `start`, callback/no-arg `scope`, reverse-order disposal, explicit disposers only.
- **Overrides**: `Module.override()` returns an inline override for `createContainer`; overrides rewire but never expose namespaces.
- **Closed views**: no public engine-container escape hatch.

## Composition semantics

- `uses` dependencies are loaded transitively.
- Exposure is explicit: only modules passed to `createContainer` get public namespaces.
- Shared dependency modules are deduplicated by module object identity; singleton entries from the same module object are shared by all importers.
- Version diamonds work: two importers can use different module objects with the same name, and each importer resolves its own dependency.
- Namespace collisions are rejected where they would be ambiguous: a module cannot directly use two same-named modules, and a container cannot expose two same-named modules.
- Cross-module cycles are unwritable because `uses` requires existing module values.
- In-module cycles are unwritable in typed code because a provider can only see earlier entries in the returned chain.

## Engine boundary

The v1 engine remains the runtime substrate:

- `src/container/` owns resolution, lifetimes, scopes, eager start, disposal, unload/override mechanics, lifecycle locking, async orphan handling, and dependency tracking.
- `src/module.ts`, `src/token.ts`, `src/types.ts`, and `src/accessors.ts` define the kernel concepts and shared accessor machinery.
- `src/module-composition/` owns names, module identity, `uses` wiring, typed resolver namespaces, view construction, and override UX.
- Shared vocabulary is engine-side and consumed upward: errors, lifetimes, token modes, resolver types, and accessor primitives.

The package entrypoint intentionally exports only the composition layer and framework errors. The token engine is an internal implementation detail for the published package surface.

## Release notes for 1.2.0

Release positioning — everything in v1.1.0, plus:

- Container options via `createContainer({ options, parts })` (exposes `onDisposeError`; scopes inherit).
- Null-prototype accessor/namespace/view hardening (fixes entry-name collisions like `source`/`toString`).
- Relaxed module naming (any identifier except `scope`/`start`/`dispose`), with compile-time identifier guards for module and entry names.
- Concurrent async-cycle detection (hardening raw engine surface): a mutual async cycle resolved by concurrent `getAsync` calls used to deadlock, because coalescing joins an in-flight promise without extending the resolution chain the per-chain circular check inspects. A root-level dependency graph (`WaitForGraph`) now tracks in-flight provider dependencies — every `resolver.getAsync(T)` from inside a provider, whether built or coalesced — and throws `CircularDependencyError` on the request that would close a cycle, instead of hanging.
  - **Conservative by contract**: the engine treats `resolver.getAsync(T)` inside a provider as _dependency acquisition_, whether or not you await the returned promise. It does not (cannot) observe JavaScript await timing, so this is in-flight dependency tracking, not "live await" detection. Consequence: fire-and-forget `void resolver.getAsync(X)` or a `Promise.race` over resolutions inside a provider that forms a cycle is reported as circular even though it might not deadlock at runtime. This is intentional — a DI container reasons about the dependency graph. (Cycles are unwritable through the composition API regardless; this only affects raw-engine deep-import use.)

Release checks run locally:

```sh
bun run quality
bun run build
npm pack --dry-run
npm view terrain-di version
```

Observed results (latest run on `main`):

- `bun run quality`: passed.
- Tests: **199 passed** across **18 files** with coverage gates met.
- Coverage summary: statements 100%, branches 99.24%, functions 100%, lines 100%.
- `bun run build`: passed; generates `dist/index.js` and `dist/index.d.ts`.

Before publishing:

- Let CI validate the exact release commit.
- Confirm the published version with `npm view terrain-di version`, and `npm pack --dry-run` (the tarball should contain only `LICENSE`, `README.md`, `dist/index.js`, `dist/index.d.ts`, `package.json`).
- Draft GitHub Release notes; no changelog file is expected.

## Examples

- `examples/public-api-usage.ts`: composition-first public API example with class-based logger/repository/use-case wiring, scopes, async config, and overrides.
- `examples/engine.ts`: deep-import reference for the internal token kernel. This is advanced/internal documentation, not the package entrypoint story.

Both examples are typechecked (`tsc -p examples/tsconfig.json`, part of `typecheck:all`) and run in CI. There is no `examples/module-composition.ts` in the current tree.

## Deferred / open

These are not current release blockers unless the maintainer decides otherwise:

- **Public type vocabulary**: current exported names include `ComposedModule` and `ModuleOverride`. Earlier notes discussed renaming the layer type to `Module` and the kernel module to `DefinitionSet` at a v2 boundary; that rename is not done.
- **Module unload/hot-swap at the composition layer**: currently out of scope; `createContainer` is static composition.
- **Module-name aliasing**: only likely to matter if a third-party module ecosystem emerges.
- **Optional resolution**: no `getOrNull`-style API.
- **Engine wait-for graph**: ~~the v1 coalesced async cycle deadlock remains an engine-level future item~~ — **resolved in 1.2.0** (see release notes): a root-level dependency graph turns the concurrent async cycle into a thrown `CircularDependencyError` instead of a hang. It is conservative by contract — `resolver.getAsync(T)` inside a provider counts as a dependency on T whether or not awaited — so it can reject fire-and-forget/`Promise.race` provider patterns. The composition layer's typed API makes those cycles unwritable in normal use; the graph hardens the raw engine surface.
- **Zero-cast accessor typing**: the composition builder still has two documented type-erasure seams (the phantom-builder casts); full zero-cast typing is a possible future cleanup.
- **Broader disposal-error hook**: `onDisposeError` observes orphaned in-flight disposal only; a hook that also observes normal `dispose()`/`unload()` failures was considered and deferred.

## Engineering infrastructure

- Test runner: Vitest via `bun run test`; `bun test` is not the configured runner.
- Full gate: `bun run quality` = oxlint + oxfmt + typechecks (`typecheck:all` = source + test + examples) + coverage-gated Vitest.
- Build: `bun run build` via `tsdown`.
- Fuzzers print `TEST_SEED` for replay:
  - `test/runs/stress.test.ts`
  - `test/runs/stress-module-composition.test.ts`
- Coverage gates in `quality`: statements 99, branches 97, functions 99, lines 100.

## Conventions to uphold

See `.agents/skills/code-clarity/SKILL.md`.

- Names do the narration; comments do the proofs.
- Prefer compile-time enforcement with runtime backstops for untyped callers.
- Fail loudly in the safe direction.
- Keep engine responsibilities and composition-layer responsibilities separate.
- Discuss design/naming before code when the change affects public API shape.
- Release-quality changes should land with tests and a green gate.

## Verification quickstart

```sh
bun run quality
bun run build
bun examples/public-api-usage.ts
TEST_SEED=<n> bun run test
```
