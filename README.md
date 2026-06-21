# terrain

[![CI](https://github.com/reactivesilicon/terrain/actions/workflows/ci.yml/badge.svg)](https://github.com/reactivesilicon/terrain/actions/workflows/ci.yml)

A pragmatic TypeScript dependency injection container.

No decorators. No reflection. No runtime dependencies. You define modules by name, declare what each one uses, and compose them into a container. Dependencies are resolved through typed namespaces, with no tokens, no casts, and no service locator plumbing. Wrong wiring fails loudly, and as much of it as possible fails at compile time.

## Installation

```sh
bun add terrain-di
```

Or with npm:

```sh
npm install terrain-di
```

## Contents

- [Why terrain?](#why-terrain)
- [Quick start](#quick-start)
- [Modules](#modules)
- [Composition with `uses`](#composition-with-uses)
- [Resolvers and namespaces](#resolvers-and-namespaces)
- [Lifetimes](#lifetimes)
- [Async entries](#async-entries) · [Eager initialization](#eager-initialization)
- [Scopes](#scopes) · [Disposal](#disposal)
- [Testing with overrides](#testing-with-overrides)
- [Guardrails](#guardrails) · [Known limitations](#known-limitations)
- [Error types](#error-types) · [API](#api)

## Why terrain?

`terrain` is designed for TypeScript projects that want dependency injection without runtime magic.

**No tokens, no casts:**

- modules are named; entries are named; resolution reads like an API
- types flow from the providers themselves — annotate a provider's return type and that type appears everywhere the entry is used, with no generic service-location calls and no token plumbing
- the sync/async split is compile-time: a sync provider can only reach sync entries; async entries resolve as promises

**Composition that the types enforce:**

- a module declares the modules it `uses`; their entries become available under their names inside its providers
- wiring is transitive (a used module is loaded automatically) but **exposure is explicit** — only the modules you hand to `createContainer` get a public namespace, so layers stay isolated by construction
- a module can only `uses` modules that already exist, so cross-module cycles are unwritable; a provider can only reach entries defined before it, so in-module cycles are unwritable

**Lifecycle, handled:**

- singleton, factory, and scoped lifetimes; sync and async providers
- request scopes (`app.scope(...)`) that are always disposed
- explicit, per-entry disposal in reverse creation order
- eager boot (`{ eager: true }` + `app.start()`) so connections fail at startup, not on the first request

**Wrong wiring fails loudly:**

- captive-dependency detection (a singleton may not depend on a scoped entry)
- duplicate entry names, duplicate module names, and non-identifier names are rejected
- only modules made by `createModule` are accepted — structural look-alikes throw

## Quick start

```ts
import { createContainer, createModule } from "terrain-di";

interface Logger {
  info(message: string): void;
}

interface UserRepo {
  find(id: string): string | null;
}

class ConsoleLogger implements Logger {
  info(message: string): void {
    console.log(message);
  }
}

class InMemoryUserRepo implements UserRepo {
  constructor(
    private readonly logger: Logger,
    private readonly rows: ReadonlyMap<string, string>,
  ) {}

  find(id: string): string | null {
    this.logger.info(`Finding user: ${id}`);
    return this.rows.get(id) ?? null;
  }
}

class FindUserUseCase {
  constructor(
    private readonly users: UserRepo,
    private readonly logger: Logger,
  ) {}

  execute(id: string): string {
    this.logger.info(`Running find-user use case: ${id}`);
    const user = this.users.find(id);
    return user ? `Found ${user}` : "User not found";
  }
}

// A module is named, and so is each of its entries. The provider's return type
// is the entry's type — no token or annotation needed at the call site.
const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => new ConsoleLogger()));

// Data declares that it uses Infra. Inside its providers, Infra's entries are
// available under `r.Infra`.
const Data = createModule("Data", { uses: [Infra] }, (m) =>
  m.single("userRepo", (r): UserRepo => new InMemoryUserRepo(r.Infra.logger(), new Map([["1", "Ada"]]))),
);

const UseCases = createModule("UseCases", { uses: [Data, Infra] }, (m) =>
  m.single("findUser", (r): FindUserUseCase => new FindUserUseCase(r.Data.userRepo(), r.Infra.logger())),
);

// Compose. Passing UseCases wires Data and Infra transitively, but only
// UseCases is exposed as a public namespace.
const app = createContainer({ parts: [UseCases] });
const findUser = app.UseCases.findUser(); // FindUserUseCase

findUser.execute("1"); // typed, token-free

await app.dispose();
```

Module names are the namespaces; entry names are the accessors. Everything in between — tokens, registration, resolution — is handled internally.

## Modules

A module groups named entries. It can only be created through `createModule` — the type system and runtime both reject hand-built look-alikes (`ForeignModuleError`).

```ts
const Infra = createModule("Infra", (m) =>
  m
    .single("config", () => ({ databaseUrl: "postgres://localhost/app" }))
    .single("logger", (): Logger => new ConsoleLogger()),
);
```

**The chain is the contract.** Each builder call returns a new builder whose type carries the entries registered so far. Keep `setup` a single returned chain — that is how types accumulate. Capturing the builder and registering imperatively is a runtime escape hatch; TypeScript cannot see the entries added that way, so the public module type will not reflect them:

```ts
// Do this — one returned chain. `b` can resolve `a`, and both are typed.
createModule("Infra", (m) => m.single("a", () => 1).single("b", (r) => r.Infra.a() + 1));

// Not this — it registers at runtime, but the module type has no `a` or `b`.
createModule("Infra", (m) => {
  m.single("a", () => 1);
  m.single("b", () => 2);
  return m;
});
```

**Module names may be any identifier except the view's reserved method names** (`scope`, `start`, `dispose`); **entry names may be any identifier.** Module names are the namespaces, and the reserved list is exactly the view's own methods. The type signature rejects literal reserved module names, and runtime backstops validate the full module and entry names (`InvalidModuleNameError`, `InvalidEntryNameError`).

## Composition with `uses`

A module lists the modules it depends on in `{ uses: [...] }`. Their entries then appear, under their module names, in this module's provider resolvers.

```ts
const Domain = createModule("Domain", { uses: [Data] }, (m) =>
  m.single("userService", (r) => ({
    getUser: (id: string) => r.Data.userRepo().find(id),
  })),
);
```

**Wiring is transitive; exposure is explicit.** When you compose a container, every `uses` dependency is loaded automatically — `Domain` pulls in `Data`, which pulls in `Infra`. But only the modules you pass to `createContainer` get a public namespace:

```ts
const app = createContainer({ parts: [Domain] }); // Data and Infra are wired, but hidden

app.Domain.userService().getUser("1"); // ok
app.Data; // type error — Data is wired but not exposed
```

This makes layer boundaries a compile-time fact: callers cannot reach past the namespaces the composition root exposes. Pass the lower modules too if you want their namespaces:

```ts
const app = createContainer({ parts: [Infra, Data, Domain] }); // all three exposed
```

**`uses` only accepts modules that already exist**, so a module can never (transitively) depend on itself — cross-module cycles are unwritable.

If two modules use the same module object, that dependency is wired once; singleton entries from it are shared by every importer. Different module objects with the same name are distinct dependencies, which is what lets version diamonds work.

A version diamond is fine: `A` can use `Core` v1 while `B` uses `Core` v2, and each importer's `r.Core` resolves to the exact module it imported. A conflict only appears where one namespace would need to hold both: a module cannot directly `uses` two modules with the same name, and a container cannot expose two modules with the same name (`DuplicateModuleNameError`).

## Resolvers and namespaces

The resolver a provider receives is namespaces all the way down — one uniform call shape, identical to the container view:

- **imported modules** appear under their names: `r.Infra.logger()`
- **the module's own earlier entries** appear under its own name: `r.Data.rows()`

```ts
const Data = createModule("Data", { uses: [Infra] }, (m) =>
  m
    .single("rows", () => new Map([["1", "Ada"]]))
    .single("userRepo", (r): UserRepo => new InMemoryUserRepo(r.Infra.logger(), r.Data.rows())),
);
```

`userRepo` can read `r.Data.rows()` because `rows` was defined before it. Referencing an entry defined _later_ in the chain is a type error — this is what makes in-module cycles impossible to write.

**Sync providers see only sync entries.** A `single` / `factory` / `scoped` provider's resolver exposes only the synchronous entries of its imports. Async entries are reachable only from async providers, so async construction can never hide behind a synchronous call:

```ts
const Infra = createModule("Infra", (m) =>
  m.single("logger", (): Logger => new ConsoleLogger()).singleAsync("config", async () => loadConfig()),
);

createModule("Data", { uses: [Infra] }, (m) =>
  m.single("userRepo", (r): UserRepo => {
    r.Infra.logger(); // ok — sync entry
    // r.Infra.config(); // type error — async entry, unreachable from a sync provider
    return new InMemoryUserRepo(r.Infra.logger(), new Map<string, string>());
  }),
);
```

## Lifetimes

Each entry has a lifetime, chosen by the builder method.

### Singleton — `single` / `singleAsync`

One instance for the whole container, created on first use and cached.

```ts
m.single("logger", (): Logger => new ConsoleLogger());
```

```ts
app.Infra.logger() === app.Infra.logger(); // true
```

### Factory — `factory` / `factoryAsync`

A new instance on every resolution.

```ts
m.factory("requestId", () => crypto.randomUUID());
```

```ts
app.Infra.requestId() === app.Infra.requestId(); // false
```

### Scoped — `scoped` / `scopedAsync`

One instance per scope (see [Scopes](#scopes)).

```ts
m.scoped("requestContext", () => new RequestContext());
```

A scoped entry resolved on the root container caches there until the root is disposed; resolved inside a scope, each scope holds its own instance.

## Async entries

Async entries use the `*Async` builder methods and resolve to a `Promise`. The accessor's return type reflects this automatically — sync entries are `() => T`, async entries are `() => Promise<T>`.

```ts
const Infra = createModule("Infra", (m) =>
  m.singleAsync("database", async () => {
    const db = new Database();
    await db.connect();
    return db;
  }),
);

const app = createContainer({ parts: [Infra] });

const db = await app.Infra.database(); // () => Promise<Database>
```

The async builder methods are `singleAsync`, `factoryAsync`, and `scopedAsync`. An async provider's resolver can reach both sync and async entries of its imports.

## Eager initialization

Resolution is lazy: an entry is constructed the first time it is resolved. For work that must finish at boot — database connections, cache warmups — mark a singleton `eager` and call `start()` before serving traffic:

```ts
const Infra = createModule("Infra", (m) =>
  m.singleAsync("database", async () => connect(), {
    eager: true,
    dispose: (db) => db.close(),
  }),
);

const app = createContainer({ parts: [Infra] });
await app.start(); // constructs every eager singleton, in parallel
server.listen(3000); // first request hits warm caches
```

`start()` resolves every eager entry in the container, in parallel, and rejects with an `AggregateError` if any construction fails — failures surface at boot, not on the first request. It is idempotent.

Only `single` and `singleAsync` accept `eager` — factories cache nothing, and a scoped entry has no scope to construct into at boot. Both misuses are compile-time errors.

## Scopes

A scope is a child of the container that gives scoped entries their own instances and can be disposed independently — ideal for per-request work.

The callback form creates a scope, runs your work, and **always disposes it** afterwards (returning your work's result):

```ts
const user = await app.scope(async (req) => {
  return req.Domain.userService().getUser("1");
});
```

If the body throws and disposal also throws, `scope` throws an `AggregateError` containing both. Scopes nest — a request scope can open transaction sub-scopes with `req.scope(...)`.

The no-argument form returns a scope view you dispose yourself:

```ts
const req = app.scope();
try {
  req.Domain.userService().getUser("1");
} finally {
  await req.dispose();
}
```

## Disposal

Teardown is registered per entry with the `{ dispose }` option. The container disposes exactly what you registered — an instance that merely happens to have a `dispose()` method is never touched.

```ts
m.single("pool", () => new Pool(config), {
  dispose: (pool) => pool.end(),
});
```

This works with any teardown method name (`close`, `destroy`, `end`, …), and the disposer is typed to the entry's value. A disposer may be async even for a sync entry — disposal always runs in an async context:

```ts
type Disposer<T> = (instance: T) => void | Promise<void>;
```

```ts
await app.dispose();
```

Disposal runs in **reverse creation order**, so dependents are torn down before their dependencies. Disposing the container cascades to all of its scopes. `dispose()` is idempotent. If multiple disposers fail, the container throws an `AggregateError`.

## Testing with overrides

Derive an override from a module to replace some of its entries, then pass the override into `createContainer` alongside the modules. The override rewires; it never adds a namespace of its own.

```ts
class SilentLogger implements Logger {
  info(_message: string): void {}
}

const FakeInfra = Infra.override((o) => o.with("logger", (): Logger => new SilentLogger()));

const app = createContainer({ parts: [UseCases, FakeInfra] }); // real wiring + the fake
app.UseCases.findUser().execute("1"); // runs against the fake logger
```

Overrides are fully checked against the original: entry names, value types, and the sync/async mode must match (`with` for sync entries, `withAsync` for async). The lifetime is inherited from the original; `eager` in an override requires the original to be a singleton.

An override applies to **every** importer of the target module — overriding `Infra` affects `Data`, `Domain`, `UseCases`, or any other consumer in the graph. That's the point: you fake one thing and the whole graph picks it up. Overriding works on transitive, unexposed modules as well. An override whose target isn't part of the container's wiring is rejected (`InvalidModuleUseError`).

An override provider may resolve the module's _other_ entries (`r.Infra.someOther()`), but fakes are expected to be self-contained — the original's imports are reachable at runtime but not surfaced in the override's types.

## Guardrails

The type system catches the wiring mistakes it can express:

- **In-module cycles are unwritable** — a provider can only reference entries defined before it.
- **Cross-module cycles are unwritable** — `uses` only accepts modules that already exist.
- **Sync providers can't reach async entries** of their imports.
- **Unknown module or entry names** are type errors.
- **Reserved module names** (`scope`, `start`, `dispose`) are rejected before runtime.

Runtime backstops catch invalid dynamic input and lifecycle failures, each as a `DIError` subclass:

- **Module names must be identifiers and not reserved view names** (`InvalidModuleNameError`).
- **Entry names must be identifiers** (`InvalidEntryNameError`).
- **Duplicate entry and module names** are rejected (`DuplicateEntryNameError`, `DuplicateModuleNameError`).
- **Only modules created by `createModule` are accepted** (`ForeignModuleError`).

### Captive dependencies

A singleton cannot depend on a scoped entry — it would outlive the scope it captured.

```ts
const Infra = createModule("Infra", (m) =>
  m
    .scoped("request", () => new RequestContext())
    .single("service", (r) => {
      const request = r.Infra.request();
      return new Service(request);
    }),
);
```

Throws `CaptiveDependencyError` on resolution.

### Missing and provider failures

- resolving an entry with no provider throws `MissingDependencyError`
- a provider that throws during construction is wrapped in `ProviderExecutionError` (unless it already is a framework error)

## Known limitations

- **Composition is static.** `createContainer` builds a fixed graph; there is no runtime unload or hot-swap of a composed container. Build a fresh container instead (this is also the testing model — a new container per test).
- **Go-to-definition on resolver namespace accessors (`r.Infra.logger`) lands on a mapped type**, not the provider. This is inherent to computed accessor types.
- **The chain is the contract.** Imperative registration on a captured builder runs at runtime but is invisible to the types — keep `setup` a single returned chain.

## Error types

`terrain` exports its framework errors:

```ts
import {
  AsyncProviderError,
  CaptiveDependencyError,
  CircularDependencyError,
  DefinitionInUseError,
  DependentInstanceError,
  DisposedContainerError,
  DuplicateDefinitionError,
  DuplicateEntryNameError,
  DuplicateModuleNameError,
  ForeignModuleError,
  InvalidDefinitionError,
  InvalidEntryNameError,
  InvalidModuleNameError,
  InvalidModuleUseError,
  LifecycleOperationError,
  MissingDependencyError,
  ModuleOwnershipError,
  ProviderExecutionError,
  ShadowedDefinitionError,
  SyncProviderError,
} from "terrain-di";
```

All framework errors extend `DIError`:

```ts
import { DIError, isFrameworkError } from "terrain-di";

try {
  app.UseCases.findUser().execute("1");
} catch (error) {
  if (error instanceof DIError) {
    // terrain-raised error
  }
}
```

`isFrameworkError(error)` is a predicate equivalent to `error instanceof DIError`, useful when you'd rather not import the base class.

## API

### `createModule`

```ts
function createModule(name, setup): ComposedModule;
function createModule(name, { uses }, setup): ComposedModule;
```

`name` must be an identifier and not a reserved view name (`scope`, `start`, `dispose`). `setup` receives a builder and must **return the chain**. With `{ uses }`, the used modules' entries are available in every provider resolver under their module names.

Builder methods — each takes `(entryName, provider, options?)` and returns the next builder in the chain:

```ts
m.single(name, provider, options?);       // options: { dispose?, eager? }
m.singleAsync(name, provider, options?);  // options: { dispose?, eager? }

m.factory(name, provider, options?);      // options: { dispose? }
m.factoryAsync(name, provider, options?); // options: { dispose? }

m.scoped(name, provider, options?);       // options: { dispose? }
m.scopedAsync(name, provider, options?);  // options: { dispose? }
```

`dispose: (instance: T) => void | Promise<void>` registers teardown; `eager: true` (singletons only) marks the entry for `start()`.

Sync methods (`single`, `factory`, `scoped`) receive a resolver with only sync entries. Async methods (`singleAsync`, `factoryAsync`, `scopedAsync`) receive a resolver with both sync and async entries. Accessors mirror the mode: sync entries are `() => T`; async entries are `() => Promise<T>`.

### `createContainer`

```ts
function createContainer<Parts>(config: { options?: ContainerOptions; parts: Parts }): ContainerView<Parts>;
```

`config.parts` are modules and module overrides, mixed in one list. Modules passed here are exposed as namespaces; their `uses` dependencies are wired transitively but not exposed. Overrides rewire their target module without exposing a namespace.

`config.options` configures the root engine container, and scopes inherit those options:

```ts
const app = createContainer({
  options: {
    onDisposeError: (error) => report(error),
  },
  parts: [UseCases],
});
```

`options.onDisposeError` observes disposal failures for orphaned in-flight instances only: a resolution that finishes after `dispose()` or `unload()` already evicted its token is disposed immediately, and failures from that orphan disposal are reported to the hook. Normal `dispose()` and `unload()` disposal failures are not reported there; those methods still reject with an `AggregateError`.

The returned view exposes one namespace per exposed module, plus:

```ts
app.start(); // Promise<void> — construct eager singletons, in parallel
app.scope(); // ScopeView — dispose it yourself
app.scope(async (view) => result); // Promise<result> — scope auto-disposed
app.dispose(); // Promise<void> — reverse-order teardown, cascades to scopes; idempotent
```

A `ScopeView` is the same shape minus `start()` — namespaces, `scope` (scopes nest), and `dispose`.

### `Module.override`

```ts
const fake = SomeModule.override((o) =>
  o.with(entryName, provider, options?).withAsync(entryName, provider, options?),
);
```

Replaces entries of the module it was derived from. `with` targets sync entries, `withAsync` async ones; entry names, value types, and modes are checked against the original. Lifetime is inherited. Pass the result into `createContainer`.

An override must replace at least one entry, and duplicate replacements are rejected.

## License

MIT
