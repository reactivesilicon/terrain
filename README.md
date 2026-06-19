# terrain

[![CI](https://github.com/reactivesilicon/terrain/actions/workflows/ci.yml/badge.svg)](https://github.com/reactivesilicon/terrain/actions/workflows/ci.yml)

A pragmatic TypeScript dependency injection container.

No decorators. No reflection. No runtime dependencies. You define modules by name, declare what each one uses, and compose them into a container. Dependencies are resolved through typed namespaces — `app.Data.users()` returns a fully typed value, with no tokens, no casts, and no manual wiring. Wrong wiring fails loudly, and as much of it as possible fails at compile time.

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

- modules are named; entries are named; resolution reads like an API: `app.Infra.logger()`
- types flow from the providers themselves — annotate a provider's return type and that type appears everywhere the entry is used, with no `get<T>()` and no token plumbing
- the sync/async split is compile-time: a sync provider can only reach sync entries; an async entry resolves to a `Promise`

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

// A module is named, and so is each of its entries. The provider's return
// type is the entry's type — no token, no annotation needed at the call site.
const Infra = createModule("Infra", (m) =>
  m.single("logger", (): Logger => ({
    info: (message) => console.log(message),
  })),
);

// Data declares that it uses Infra. Inside its providers, Infra's entries are
// available under `r.Infra`.
const Data = createModule("Data", { uses: [Infra] }, (m) =>
  m.single("users", (r) => {
    const logger = r.Infra.logger();
    return {
      createUser(name: string) {
        logger.info(`Created user: ${name}`);
      },
    };
  }),
);

// Compose. Passing Data wires Infra transitively; passing Infra too exposes
// its namespace on the container.
const app = createContainer(Infra, Data);

app.Data.users().createUser("Ada"); // typed, token-free
app.Infra.logger().info("done");

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

**The chain is the contract.** Each builder call returns a new builder whose type carries the entries registered so far. Keep `setup` a single returned chain — that is how types accumulate. Capturing the builder and registering imperatively (inside an `if`, say) works at runtime but is invisible to the types:

```ts
// Do this — one returned chain.
createModule("Infra", (m) => m.single("a", ...).single("b", ...));

// Not this — the entries won't be typed.
createModule("Infra", (m) => {
  m.single("a", ...);
  if (cond) m.single("b", ...);
});
```

**Module names must be PascalCase; entry names must be valid identifiers.** Module names are the namespaces and the container's own API (`scope`, `start`, `dispose`) is lowercase, so a namespace can never collide with a method — there is no reserved-word list to remember. Both rules are compile-time errors and runtime backstops (`InvalidModuleNameError`, `InvalidEntryNameError`).

## Composition with `uses`

A module lists the modules it depends on in `{ uses: [...] }`. Their entries then appear, under their module names, in this module's provider resolvers.

```ts
const Domain = createModule("Domain", { uses: [Data] }, (m) =>
  m.single("userService", (r) => ({
    getUser: (id: string) => r.Data.users().find(id),
  })),
);
```

**Wiring is transitive; exposure is explicit.** When you compose a container, every `uses` dependency is loaded automatically — `Domain` pulls in `Data`, which pulls in `Infra`. But only the modules you pass to `createContainer` get a public namespace:

```ts
const app = createContainer(Domain); // Data and Infra are wired, but hidden

app.Domain.userService().getUser("1"); // ok
app.Data; // type error — Data is wired but not exposed
```

This makes layer boundaries a compile-time fact: an outer layer cannot reach past the surface a module chose to expose. Pass the lower modules too if you want their namespaces:

```ts
const app = createContainer(Infra, Data, Domain); // all three exposed
```

**`uses` only accepts modules that already exist**, so a module can never (transitively) depend on itself — cross-module cycles are unwritable.

A module used by two others at different versions is fine: each importer's `r.Core` resolves to the exact module it imported. Only exposing two modules with the *same name* on one container conflicts (`DuplicateModuleNameError`).

## Resolvers and namespaces

The resolver a provider receives is namespaces all the way down — one uniform call shape, identical to the container view:

- **imported modules** appear under their names: `r.Infra.logger()`
- **the module's own earlier entries** appear under its own name: `r.Data.cache()`

```ts
const Data = createModule("Data", { uses: [Infra] }, (m) =>
  m
    .single("cache", () => new Map<string, string>())
    .single("users", (r) => new UserRepo(r.Data.cache(), r.Infra.logger())),
);
```

`users` can read `r.Data.cache()` because `cache` was defined before it. Referencing an entry defined *later* in the chain is a type error — this is what makes in-module cycles impossible to write.

**Sync providers see only sync entries.** A `single` / `factory` / `scoped` provider's resolver exposes only the synchronous entries of its imports. Async entries are reachable only from async providers, so async construction can never hide behind a synchronous call:

```ts
const Infra = createModule("Infra", (m) =>
  m
    .single("logger", (): Logger => new ConsoleLogger())
    .singleAsync("config", async () => loadConfig()),
);

createModule("Data", { uses: [Infra] }, (m) =>
  m.single("users", (r) => {
    r.Infra.logger(); // ok — sync entry
    r.Infra.config(); // type error — async entry, unreachable from a sync provider
    return new UserRepo();
  }),
);
```

## Lifetimes

Each entry has a lifetime, chosen by the builder method.

### Singleton — `single` / `singleAsync`

One instance for the whole container, created on first use and cached.

```ts
m.single("logger", () => new Logger());
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

const app = createContainer(Infra);

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

const app = createContainer(Infra);
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
const FakeInfra = Infra.override((o) =>
  o
    .with("logger", (): Logger => ({ info: () => {} })) // sync entries
    .withAsync("database", async () => fakeDb, { eager: true }), // async entries
);

const app = createContainer(Domain, FakeInfra); // real wiring + the fake
app.Domain.userService().getUser("1"); // runs against the fake logger and database
```

Overrides are fully checked against the original: entry names, value types, and the sync/async mode must match (`with` for sync entries, `withAsync` for async). The lifetime is inherited from the original; `eager` in an override requires the original to be a singleton.

An override applies to **every** importer of the target module — overriding `Infra` affects `Data` and `Domain` too, even though they're separate modules. That's the point: you fake one thing and the whole graph picks it up. Overriding works on transitive, unexposed modules as well. An override whose target isn't part of the container's wiring is rejected (`InvalidModuleUseError`).

An override provider may resolve the module's *other* entries (`r.Infra.someOther()`), but fakes are expected to be self-contained — the original's imports are reachable at runtime but not surfaced in the override's types.

## Guardrails

Most wiring mistakes are caught at compile time:

- **In-module cycles are unwritable** — a provider can only reference entries defined before it.
- **Cross-module cycles are unwritable** — `uses` only accepts modules that already exist.
- **Sync providers can't reach async entries** of their imports.
- **Unknown module or entry names** are type errors.
- **Module names must be PascalCase; entry names must be identifiers.**

The rest are runtime guards, each a `DIError` subclass:

### Captive dependencies

A singleton cannot depend on a scoped entry — it would outlive the scope it captured.

```ts
const Infra = createModule("Infra", (m) =>
  m
    .scoped("request", () => new RequestContext())
    .single("service", (r) => new Service(r.Infra.request())),
);
```

Throws `CaptiveDependencyError` on resolution.

### Missing, duplicate, and foreign

- resolving an entry with no provider throws `MissingDependencyError`
- a duplicate entry name within a module throws `DuplicateEntryNameError`
- two exposed modules sharing a name throws `DuplicateModuleNameError`
- passing anything not made by `createModule` throws `ForeignModuleError`
- a provider that throws during construction is wrapped in `ProviderExecutionError` (unless it already is a framework error)

## Known limitations

- **Composition is static.** `createContainer` builds a fixed graph; there is no runtime unload or hot-swap of a composed container. Build a fresh container instead (this is also the testing model — a new container per test).
- **Go-to-definition on `r.Infra.logger` lands on a mapped type**, not the provider. This is inherent to computed accessor types.
- **The chain is the contract.** Imperative registration on a captured builder runs at runtime but is invisible to the types — keep `setup` a single returned chain.

## Error types

`terrain` exports its framework errors:

```ts
import {
  CaptiveDependencyError,
  CircularDependencyError,
  DisposedContainerError,
  DuplicateEntryNameError,
  DuplicateModuleNameError,
  ForeignModuleError,
  InvalidEntryNameError,
  InvalidModuleNameError,
  InvalidModuleUseError,
  MissingDependencyError,
  ProviderExecutionError,
} from "terrain-di";
```

All framework errors extend `DIError`:

```ts
import { DIError, isFrameworkError } from "terrain-di";

try {
  app.Domain.userService().getUser("1");
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

`name` must be PascalCase. `setup` receives a builder and must **return the chain**. With `{ uses }`, the used modules' entries are available in every provider resolver under their module names.

Builder methods — each takes `(entryName, provider, options?)` and returns the builder:

```ts
m.single(name, provider, options?);       // options: { dispose?, eager? }
m.singleAsync(name, provider, options?);  // options: { dispose?, eager? }

m.factory(name, provider, options?);      // options: { dispose? }
m.factoryAsync(name, provider, options?); // options: { dispose? }

m.scoped(name, provider, options?);       // options: { dispose? }
m.scopedAsync(name, provider, options?);  // options: { dispose? }
```

`dispose: (instance: T) => void | Promise<void>` registers teardown; `eager: true` (singletons only) marks the entry for `start()`.

### `createContainer`

```ts
function createContainer(...parts): ContainerView;
```

`parts` are modules and module overrides, mixed in one list. Modules passed here are exposed as namespaces; their `uses` dependencies are wired transitively but not exposed. Overrides rewire their target module without exposing a namespace.

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

## License

MIT
