# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First public release of `terrain-di`: a pragmatic TypeScript dependency
injection container. No decorators, no reflection, no runtime dependencies.

### Tokens

- Object tokens with compile-time brands: `createSyncToken<T>()` /
  `createAsyncToken<T>()`. The sync/async resolution split is enforced by the
  type system — `get()` rejects async tokens and `getAsync()` rejects sync
  tokens at compile time, with runtime errors as a backstop for untyped
  callers.
- Tokens carry `description` and `mode`, print readably through `toString`,
  `JSON.stringify`, and Node's `inspect`, and cannot be forged structurally.

### Container

- Modules (`createModule`) with `single` / `factory` / `scoped` lifetimes,
  each in sync and async variants.
- Hierarchical scopes (`createScope` / `withScope`); every container is a
  scope, the root being the outermost one.
- Explicit per-definition teardown via `{ dispose }` — no `dispose()`
  duck-typing. Disposal runs in reverse creation order and is keyed by token,
  so unloading an alias never destroys the owner's resource.
- Eager boot: `{ eager: true }` on singletons plus `container.start()`
  constructs them in parallel before serving traffic.
- Token-free call sites via `createAccessors(container, spec)`.

### Safety guarantees

- Circular, captive, shadowed, and duplicate wiring fail loudly with typed
  errors.
- `unload()` refuses to evict definitions that live instances still depend on
  (`DependentInstanceError`), tracked through a construction-time dependency
  graph, and only accepts the module object that loaded the definitions
  (`ModuleOwnershipError`).
- Tree-wide lifecycle locking; in-flight async resolutions that settle after
  teardown are orphaned and disposed instead of leaking into dead containers.
- Known limitations are documented in the README.
