# terrain

A pragmatic TypeScript Dependency Injection framework

No decorators. No reflection. No framework dependency. Just a small, explicit, DSL-based container with typed tokens, modules, scopes, async providers, disposal, and lifecycle safety.

## Installation

```sh
bun add terrain
```

Or with npm:

```sh
npm install terrain
```

## Why terrain?

`terrain` is designed for TypeScript projects that want dependency injection without runtime magic.

It gives you:

- typed tokens
- singleton, factory, and scoped lifetimes
- sync and async providers
- module-based registration
- child scopes
- deterministic disposal
- circular dependency detection
- captive dependency detection
- lazy injection helpers
- safe module unload/reload
- lifecycle guards for async teardown

## Quick start

```ts
import { Container, createModule, createSyncToken } from "terrain";

class Logger {
  info(message: string): void {
    console.log(message);
  }
}

class UserService {
  constructor(private readonly logger: Logger) {}

  createUser(name: string): void {
    this.logger.info(`Created user: ${name}`);
  }
}

const LoggerToken = createSyncToken<Logger>("Logger");
const UserServiceToken = createSyncToken<UserService>("UserService");

const appModule = createModule((module) => {
  module.single(LoggerToken, () => new Logger());

  module.single(UserServiceToken, (resolver) => {
    return new UserService(resolver.get(LoggerToken));
  });
});

const container = new Container();

container.load(appModule);

const userService = container.get(UserServiceToken);

userService.createUser("Ada");
```

## Tokens

Dependencies are identified by typed tokens.

```ts
import { createSyncToken, createAsyncToken } from "terrain";

const ConfigToken = createSyncToken<{ databaseUrl: string }>("Config");
const DatabaseToken = createAsyncToken<Database>("Database");
```

The token carries the TypeScript type of the dependency:

```ts
const config = container.get(ConfigToken);

// config is typed as:
// { databaseUrl: string }
```

A token also carries its resolution mode. `createSyncToken` makes a `Token<T>` for
synchronous providers, resolved with `get`. `createAsyncToken` makes an
`AsyncToken<T>` for async providers, resolved with `getAsync`. The two are not
interchangeable: passing an async token to `get` (or registering it with a sync
builder method) is a compile-time error.

## Modules

Modules group dependency definitions.

```ts
const appModule = createModule((module) => {
  module.single(ConfigToken, () => ({
    databaseUrl: "postgres://localhost/app",
  }));
});
```

Load a module into a container:

```ts
const container = new Container();

container.load(module);
```

Unload a module:

```ts
await container.unload(module);
```

A module can only be unloaded from the container that owns its definitions.

## Lifetimes

### Singleton

One instance per owning container.

```ts
module.single(LoggerToken, () => new Logger());
```

The same instance is returned every time:

```ts
const a = container.get(LoggerToken);
const b = container.get(LoggerToken);

console.log(a === b); // true
```

### Factory

A new instance is created on every resolution.

```ts
module.factory(RequestIdToken, () => crypto.randomUUID());
```

Each call creates a new value:

```ts
const a = container.get(RequestIdToken);
const b = container.get(RequestIdToken);

console.log(a === b); // false
```

### Scoped

One instance per scope.

```ts
module.scoped(RequestContextToken, () => new RequestContext());
```

```ts
const scopeA = container.createScope();
const scopeB = container.createScope();

const a1 = scopeA.get(RequestContextToken);
const a2 = scopeA.get(RequestContextToken);
const b1 = scopeB.get(RequestContextToken);

console.log(a1 === a2); // true
console.log(a1 === b1); // false
```

Dispose a scope when finished:

```ts
await scopeA.dispose();
await scopeB.dispose();
```

## `withScope`

Use `withScope` to create a temporary scope that is always disposed.

```ts
await container.withScope(async (scope) => {
  const context = scope.get(RequestContextToken);

  // use scoped dependencies here
});
```

If the body throws and disposal also throws, `withScope` throws an `AggregateError` containing both failures.

## Async providers

Async providers use async tokens and explicit async registration methods.

```ts
const DatabaseToken = createAsyncToken<Database>("Database");

const dbModule = createModule((module) => {
  module.singleAsync(DatabaseToken, async () => {
    const db = new Database();

    await db.connect();

    return db;
  });
});
```

Resolve async providers with `getAsync`:

```ts
const db = await container.getAsync(DatabaseToken);
```

Calling `get` with an async token is a compile-time error. For untyped
callers that bypass the type system, the runtime still throws
`AsyncProviderError` (and `getAsync` on a sync definition throws
`SyncProviderError`).

Available async registration methods (each requires an `AsyncToken`):

```ts
module.singleAsync(AsyncToken, async (resolver) => value);
module.factoryAsync(AsyncToken, async (resolver) => value);
module.scopedAsync(AsyncToken, async (resolver) => value);
```

## Eager initialization

Resolution is lazy: an instance is constructed the first time its token is resolved. For work that must finish at boot — database connections, cache warmups — mark the singleton `eager` and call `start()` before serving traffic:

```ts
const dbModule = createModule((module) => {
  module.singleAsync(DatabaseToken, async () => connect(), {
    eager: true,
    dispose: (db) => db.close(),
  });
});

container.load(dbModule);
await container.start(); // constructs all eager singletons, in parallel
server.listen(3000); // first request hits warm caches
```

`start()` resolves every eager definition loaded on that container, in parallel, and rejects with an `AggregateError` if any construction fails — failures surface at boot, not on the first request. It is idempotent; already-constructed singletons are untouched, so it is safe to call again after loading more modules.

Because eager construction happens at `start()` rather than at `load()`, the testing story is unaffected: load overrides first, then start.

Only `single` and `singleAsync` accept `eager` — factories cache nothing, and a scoped definition has no scope to construct into at boot. Both misuses are compile-time errors.

## Sync and async resolvers

Synchronous providers receive a sync resolver:

```ts
module.single(ServiceToken, (resolver) => {
  return new Service(resolver.get(LoggerToken));
});
```

Async providers receive an async resolver:

```ts
module.singleAsync(ServiceToken, async (resolver) => {
  const db = await resolver.getAsync(DatabaseToken);

  return new Service(db);
});
```

Sync providers do not receive `getAsync`. This prevents accidentally hiding async construction behind a sync API.

## Lazy injection

Use `inject` to create a lazy getter.

```ts
const getLogger = container.inject(LoggerToken);

const logger = getLogger();
```

Use `injectAsync` for async dependencies.

```ts
const getDatabase = container.injectAsync(DatabaseToken);

const database = await getDatabase();
```

The lazy getter does not cache independently. It always resolves through the container, so factory semantics are preserved.

## Accessors

Use `createAccessors` to give consumers named accessors instead of tokens. Tokens stay a wiring detail; call sites read like an API.

```ts
import { createAccessors } from "terrain";

const app = createAccessors(container, {
  logger: LoggerToken, // sync token  -> app.logger(): Logger
  db: DatabaseToken, // async token -> app.db(): Promise<Database>
});

app.logger().info("hello");
const db = await app.db();
```

The return type of each accessor is derived from the token kind: sync tokens produce `() => T`, async tokens produce `() => Promise<T>`.

Accessors are lazy `inject`-style getters: each call resolves through the container, honoring the definition's lifetime (a `factory` member returns a fresh value per call). They can be created before their modules are loaded, and every accessor throws once the container is disposed.

For per-request work, build the accessors over a scope:

```ts
await root.withScope(async (scope) => {
  const req = createAccessors(scope, { handler: HandlerToken });
  return req.handler().handle(userId);
});
```

Accessors are best kept at the edges — composition roots, route handlers, CLI entry points. Business logic should still receive its dependencies as parameters rather than reaching into an accessor object, so its dependencies stay visible in its signature.

## Disposal

Teardown is registered per definition with the `{ dispose }` option. The container disposes exactly what you registered, how you registered it — an instance that merely happens to have a `dispose()` method is never touched.

```ts
module.single(DbToken, () => new Pool(config), {
  dispose: (pool) => pool.end(),
});
```

This works with any teardown method name (`close`, `destroy`, `end`, `disconnect`, …), and the disposer is typed to the token's value. A disposer may be async even for a sync token — disposal always runs in an async context:

```ts
type Disposer<T> = (instance: T) => void | Promise<void>;
```

Disposal runs in reverse creation order.

```ts
await container.dispose();
```

This helps dependents dispose before their dependencies.

Definitions without `{ dispose }` are simply dropped at teardown. Factory instances are caller-owned: their disposer is only used when an in-flight async factory result is orphaned by a concurrent teardown.

Disposal records are keyed by token. If two tokens share one instance (an alias definition returning `resolver.get(Owner)`), each token's disposer runs only when that token is torn down — unloading the alias never destroys the owner's resource. Register resource-destroying cleanup only on the definition that created the resource; an alias's disposer should release just what the alias itself added.

If multiple disposals fail, the container throws an `AggregateError`.

## Lifecycle semantics

`terrain` has strict lifecycle rules.

Only one lifecycle operation may run per container tree at a time:

```ts
container.load(module);
await container.unload(module);
await container.dispose();
```

Concurrent lifecycle operations reject with `LifecycleOperationError`.

Disposing a parent container disposes all child scopes.

A disposed ancestor makes the entire subtree unusable. Child scopes cannot continue resolving local dependencies after their parent begins disposal.

`dispose()` is idempotent. Calling it more than once is safe.

Factories are caller-owned after successful construction. During teardown, in-flight factory providers are awaited. If they finish after their token was unloaded or their container tree was disposed, their result is treated as an orphan, disposed if possible, and the caller receives `DisposedContainerError`.

## Unload and hot-swap

You can unload a module and load a replacement.

```ts
await container.unload(oldModule);

container.load(newModule);
```

Unload is refused with `DependentInstanceError` while a live instance outside the module depends on one of its definitions — otherwise that instance would be left holding a disposed dependency. Unload or dispose the dependents first (or unload everything in one module). The check is conservative: any token a provider resolved during construction counts as captured. Its limit: references held by application code (a top-level `get()` result) cannot be tracked.

You cannot override a token while it has a cached or in-flight instance.

```ts
container.load(module, { override: true });
```

Override is rejected if the existing definition is in use.

## Guardrails

### Missing dependencies

```ts
container.get(MissingToken);
```

Throws `MissingDependencyError`.

### Circular dependencies

```ts
const AToken = createSyncToken<A>("A");
const BToken = createSyncToken<B>("B");

const appModule = createModule((module) => {
  module.single(AToken, (resolver) => new A(resolver.get(BToken)));
  module.single(BToken, (resolver) => new B(resolver.get(AToken)));
});
```

Throws `CircularDependencyError`.

### Captive dependencies

A singleton cannot depend on a scoped dependency.

```ts
module.scoped(RequestToken, () => new RequestContext());

module.single(ServiceToken, (resolver) => {
  return new Service(resolver.get(RequestToken));
});
```

Throws `CaptiveDependencyError`.

This prevents a singleton from capturing a dependency that should only live for a scope.

### Shadowed definitions

A token cannot be defined in both an ancestor and descendant container.

```ts
root.load(rootModule);
scope.load(scopeModuleWithSameToken);
```

Throws `ShadowedDefinitionError`.

This keeps resolution ownership predictable.

## Testing with overrides

A common test pattern is to load a test module instead of the production module.

```ts
const RealApiToken = createSyncToken<ApiClient>("ApiClient");

const testModule = createModule((module) => {
  module.single(RealApiToken, () => new FakeApiClient());
});

const container = new Container();

container.load(testModule);
```

For hot replacement, unload first:

```ts
await container.unload(oldModule);

container.load(testModule);
```

## Error types

`terrain` exports framework errors:

```ts
import {
  AsyncProviderError,
  CaptiveDependencyError,
  CircularDependencyError,
  DefinitionInUseError,
  DependentInstanceError,
  DisposedContainerError,
  DuplicateDefinitionError,
  LifecycleOperationError,
  MissingDependencyError,
  ModuleOwnershipError,
  ProviderExecutionError,
  ShadowedDefinitionError,
} from "terrain";
```

All framework errors extend `DIError`.

```ts
import { DIError, isFrameworkError } from "terrain";

try {
  container.get(Token);
} catch (error) {
  if (error instanceof DIError) {
    // terrain-raised error
  }
}
```

`isFrameworkError(error)` is a predicate equivalent to `error instanceof DIError`. Useful when you want to check without importing the base class.

Provider-thrown errors are wrapped in `ProviderExecutionError`, unless they are already framework errors.

## Module branding

`Module` is branded at the TypeScript type level.

This prevents ordinary object literals from satisfying the `Module` interface and bypassing builder validation.

This is compile-time protection, not runtime security. Code using `as any` can still bypass TypeScript. Use `createModule()` and `ModuleBuilder` as the supported construction API.

## API

### `createSyncToken`

```ts
function createSyncToken<T>(description: string): Token<T>;
```

Creates a typed dependency token.

### `createModule`

```ts
function createModule(setup: (builder: ModuleBuilder) => void): Module;
```

Creates a module.

### `Container`

```ts
const container = new Container();
const container = new Container({ onDisposeError: (error) => console.error(error) });
```

`onDisposeError` is called when an in-flight async instance finishes constructing after its token was already unloaded or its container disposed. The result is treated as an orphan and disposed immediately. Errors from that orphan disposal are reported here. Errors from normal `dispose()` or `unload()` are thrown directly from those methods, not reported via this callback.

Methods:

```ts
container.load(module);
container.load(module, { override: true });
await container.unload(module);

container.get(Token);
await container.getAsync(AsyncToken);

await container.start();

container.has(Token); // accepts Token or AsyncToken

container.inject(Token);
container.injectAsync(AsyncToken);

container.createScope();
await container.withScope(async (scope) => {});

await container.dispose();
```

### `ModuleBuilder`

Registration methods:

```ts
module.single(Token, provider);
module.singleAsync(Token, provider);

module.factory(Token, provider);
module.factoryAsync(Token, provider);

module.scoped(Token, provider);
module.scopedAsync(Token, provider);
```

## License

MIT
