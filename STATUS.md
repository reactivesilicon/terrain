# terrain — project status

> Maintainer notes. Updated 2026-06-19, branch `leap-q1`.

## Where things stand

**`main`** holds the released **terrain v1.0.0** token-based API.

- npm package: **`terrain-di`**; the bare name `terrain` is squatted.
- Current published npm version checked during release prep: **`1.0.0`**.
- GitHub Releases is the changelog channel; `CHANGELOG.md` was deliberately removed.
- The v1 token engine still exists in this branch, but it is no longer the package entrypoint.

**`leap-q1`** is the composition-first public API branch and current release candidate for **`terrain-di@1.1.0`**.

- `src/index.ts` exports `errors`, `module-composition`, and option/disposer types. Tokens, the raw `Container`, and the kernel `ModuleBuilder` are internal implementation details reachable only by deep imports.
- `README.md` now documents the composition API as the primary API.
- `package.json` is bumped to `1.1.0`.
- `npm pack --dry-run` has been verified for `terrain-di@1.1.0`; the tarball contains only `LICENSE`, `README.md`, `dist/index.js`, `dist/index.d.ts`, and `package.json`.

## Public API now

```ts
const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => new ConsoleLogger()));
const Data = createModule("Data", { uses: [Infra] }, (m) =>
  m.single("userRepo", (r): UserRepo => new InMemoryUserRepo(r.Infra.logger(), new Map([["1", "Ada"]]))),
);
const UseCases = createModule("UseCases", { uses: [Data, Infra] }, (m) =>
  m.single("findUser", (r): FindUserUseCase => new FindUserUseCase(r.Data.userRepo(), r.Infra.logger())),
);

const app = createContainer(UseCases);
app.UseCases.findUser().execute("1");
await app.dispose();
```

- **No public tokens**: entry names are the handles; internal tokens are minted as implementation currency.
- **Typed namespaces**: modules passed to `createContainer` are exposed as namespaces; transitive `uses` dependencies are wired but hidden unless passed explicitly.
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

## Release notes for 1.1.0

Release positioning:

- Composition-first API.
- Named modules and typed namespace accessors.
- Transitive wiring with explicit namespace exposure.
- Scoped views and callback scopes.
- Async providers and eager initialization.
- Module overrides for testing/fakes.
- Deterministic explicit disposal.

Release checks already run locally:

```sh
bun run quality
bun run build
npm pack --dry-run
npm view terrain-di version
```

Observed results:

- `bun run quality`: passed.
- Tests: **173 passed** across **16 files** with coverage gates met.
- Coverage summary from the latest run: statements 99.85%, branches 99.14%, functions 99.54%, lines 100%.
- `bun run build`: passed; generated `dist/index.js` and `dist/index.d.ts`.
- `npm pack --dry-run`: passed for `terrain-di@1.1.0`.
- npm currently publishes `terrain-di@1.0.0`; `1.1.0` is available to publish.

Before publishing:

- Push `leap-q1` and let CI validate the exact commit.
- Draft GitHub Release notes; no changelog file is expected.
- Confirm whether the release should be published from `leap-q1` directly or merged/tagged through `main`.

## Examples

- `examples/public-api-usage.ts`: composition-first public API example with class-based logger/repository/use-case wiring, scopes, async config, and overrides.
- `examples/engine.ts`: deep-import reference for the internal token kernel. This is advanced/internal documentation, not the package entrypoint story.

There is no `examples/module-composition.ts` in the current tree.

## Deferred / open

These are not current release blockers unless the maintainer decides otherwise:

- **Public type vocabulary**: current exported names include `ComposedModule` and `ModuleOverride`. Earlier notes discussed renaming the layer type to `Module` and the kernel module to `DefinitionSet` at a v2 boundary; that rename is not done in this 1.1.0 candidate.
- **Composition container options**: `createContainer(...parts)` cannot pass engine `ContainerOptions` such as `onDisposeError`; natural future shape is an overload like `createContainer(options, ...parts)`.
- **Module unload/hot-swap at the composition layer**: currently out of scope; `createContainer` is static composition.
- **Module-name aliasing**: only likely to matter if a third-party module ecosystem emerges.
- **Optional resolution**: no `getOrNull`-style API.
- **Engine wait-for graph**: the v1 coalesced async cycle deadlock remains an engine-level future item, but the composition layer's typed API makes those cycles unwritable in normal use.
- **Zero-cast accessor typing**: possible future cleanup around branded accessor prototypes and split builders.

## Engineering infrastructure

- Test runner: Vitest via `bun run test`; `bun test` is not the configured runner.
- Full gate: `bun run quality` = oxlint + oxfmt + source typecheck + test typecheck + coverage-gated Vitest.
- Build: `bun run build` via `tsdown`.
- Fuzzers print `TEST_SEED` for replay:
  - `test/runs/stress.test.ts`
  - `test/runs/stress-module-composition.test.ts`
- Benchmark: `bench/module-composition-type-bench.mjs`.
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
node bench/module-composition-type-bench.mjs
```
