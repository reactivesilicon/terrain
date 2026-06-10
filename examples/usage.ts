/**
 * terrain — usage patterns
 *
 * Run with:  bun examples/usage.ts
 *
 * Each section is self-contained and prints what it demonstrates. Read top to
 * bottom; the patterns build on each other.
 */

import {
  Container,
  createAsyncToken,
  createAccessors,
  createModule,
  createSyncToken,
  CaptiveDependencyError,
  CircularDependencyError,
  DefinitionInUseError,
  LifecycleOperationError,
  ShadowedDefinitionError,
  type AsyncResolver,
  type SyncResolver,
} from "../src";

const line = (title: string) => console.log(`\n=== ${title} ===`);

// ───────────────────────────────────────────────────────────────────────────
// 1. Tokens + the three lifetimes
// ───────────────────────────────────────────────────────────────────────────
//
// A Token<T> is a typed handle. get(token) returns T with no casting. Tokens
// are created once and shared (usually exported from a "tokens" module).

async function lifetimes() {
  line("1. lifetimes: single / factory / scoped");

  interface Clock {
    now(): number;
  }

  const ClockToken = createSyncToken<Clock>("Clock");
  const RequestIdToken = createSyncToken<string>("RequestId");
  const GreetingToken = createSyncToken<string>("Greeting");

  const appModule = createModule((module) => {
    // single  -> one shared instance for the whole container tree
    module.single(ClockToken, () => ({ now: () => Date.now() }));

    // factory -> a brand new value every get()
    module.factory(GreetingToken, () => `hello-${Math.random().toString(36).slice(2, 6)}`);

    // scoped  -> one instance per scope (see section 4)
    module.scoped(RequestIdToken, () => Math.random().toString(36).slice(2));
  });

  const app = new Container();
  app.load(appModule);

  console.log("single is shared:", app.get(ClockToken) === app.get(ClockToken));
  console.log("factory differs:", app.get(GreetingToken) !== app.get(GreetingToken));
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Wiring dependencies — the resolver argument
// ───────────────────────────────────────────────────────────────────────────
//
// Providers receive a resolver. Call get() on it to pull in dependencies.
// Sync providers get a SyncResolver (no getAsync); async providers get an
// AsyncResolver. This is the idiomatic "constructor injection" shape.

function wiring() {
  line("2. wiring dependencies");

  interface Logger {
    log(msg: string): void;
  }
  interface Db {
    query(sql: string): string[];
  }
  interface UserRepo {
    find(id: string): string | null;
  }

  const LoggerToken = createSyncToken<Logger>("Logger");
  const DbToken = createSyncToken<Db>("Db");
  const UserRepoToken = createSyncToken<UserRepo>("UserRepo");

  class ConsoleLogger implements Logger {
    log(msg: string) {
      console.log(`  [log] ${msg}`);
    }
  }
  class PgDb implements Db {
    constructor(private logger: Logger) {}
    query(sql: string) {
      this.logger.log(`query: ${sql}`);
      return ["alice"];
    }
  }
  class UserRepoImpl implements UserRepo {
    constructor(
      private db: Db,
      private logger: Logger,
    ) {}
    find(id: string) {
      this.logger.log(`find ${id}`);
      return this.db.query(`select * from users where id='${id}'`)[0] ?? null;
    }
  }

  const appModule = createModule((module) => {
    module.single(LoggerToken, () => new ConsoleLogger());
    // The resolver is typed as SyncResolver — no getAsync available here.
    module.single(DbToken, (resolver: SyncResolver) => new PgDb(resolver.get(LoggerToken)));
    module.single(UserRepoToken, (resolver) => new UserRepoImpl(resolver.get(DbToken), resolver.get(LoggerToken)));
  });

  const app = new Container();
  app.load(appModule);

  console.log("found user:", app.get(UserRepoToken).find("1"));
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Async providers
// ───────────────────────────────────────────────────────────────────────────
//
// Async definitions use async tokens (createAsyncToken) and are registered
// with singleAsync / factoryAsync / scopedAsync, then resolved with getAsync().
// The split is enforced at compile time: get() does not accept an AsyncToken
// and getAsync() does not accept a Token. The runtime guards remain as a
// backstop for untyped callers, so async work never starts unexpectedly.

async function asyncProviders() {
  line("3. async providers");

  interface Connection {
    ping(): string;
  }
  const ConnectionToken = createAsyncToken<Connection>("Connection");

  const connectionModule = createModule((module) => {
    module.singleAsync(ConnectionToken, async (resolver: AsyncResolver) => {
      void resolver; // async providers receive an AsyncResolver — r.get() and r.getAsync() both available
      await new Promise((res) => setTimeout(res, 10)); // simulate connect()
      return { ping: () => "pong" };
    });
  });

  const app = new Container();
  app.load(connectionModule);

  // Concurrent getAsync of the same singleton runs the provider exactly once.
  const [a, b] = await Promise.all([app.getAsync(ConnectionToken), app.getAsync(ConnectionToken)]);
  console.log("async singleton coalesced:", a === b, "| ping:", a.ping());
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Scopes — per-request / per-job instances
// ───────────────────────────────────────────────────────────────────────────
//
// createScope() makes a child container. It inherits the parent's definitions,
// but `scoped` definitions get a fresh instance per scope. Singletons defined
// on the parent stay shared. Use withScope() to auto-dispose.

async function scopes() {
  line("4. scopes");

  const RequestIdToken = createSyncToken<string>("RequestId");
  const ConfigToken = createSyncToken<{ env: string }>("Config");

  const root = new Container();
  root.load(
    createModule((module) => {
      module.single(ConfigToken, () => ({ env: "prod" })); // shared everywhere
      module.scoped(RequestIdToken, () => Math.random().toString(36).slice(2, 8)); // per scope
    }),
  );

  const s1 = root.createScope();
  const s2 = root.createScope();

  console.log("scoped differs across scopes:", s1.get(RequestIdToken) !== s2.get(RequestIdToken));
  console.log("scoped stable within a scope:", s1.get(RequestIdToken) === s1.get(RequestIdToken));
  console.log("singleton shared into scopes:", s1.get(ConfigToken) === s2.get(ConfigToken));

  await s1.dispose();
  await s2.dispose();

  // withScope: scope is created, used, and disposed automatically.
  const result = await root.withScope(async (scope) => {
    return `handled request ${scope.get(RequestIdToken)}`;
  });
  console.log("withScope:", result);
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Disposal & lifecycle
// ───────────────────────────────────────────────────────────────────────────
//
// Teardown is registered per definition via { dispose }. The container only
// disposes what you registered — there is no dispose() duck-typing — and runs
// disposers in REVERSE creation order when the container is disposed.
// Factories are caller-owned and never auto-disposed.

async function disposal() {
  line("5. disposal (reverse creation order)");

  const PoolToken = createSyncToken<{ close(): void }>("Pool");
  const ServiceToken = createSyncToken<{ close(): void }>("Service");

  const order: string[] = [];
  const app = new Container();
  app.load(
    createModule((module) => {
      module.single(PoolToken, () => ({ close: () => order.push("pool") }), { dispose: (pool) => pool.close() });
      module.single(
        ServiceToken,
        (resolver) => {
          resolver.get(PoolToken); // Service depends on Pool -> Pool created first
          return { close: () => order.push("service") };
        },
        { dispose: (svc) => svc.close() },
      );
    }),
  );

  app.get(ServiceToken);
  await app.dispose();
  console.log("disposal order:", order.join(" -> ")); // service -> pool
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Lazy injection
// ───────────────────────────────────────────────────────────────────────────
//
// inject(token) returns a getter that resolves on each call (honoring the
// definition's lifetime). Handy for breaking construction-time ordering or
// deferring an expensive build.

function lazyInjection() {
  line("6. lazy injection");

  const HeavyToken = createSyncToken<{ value: number }>("Heavy");
  let built = 0;

  const app = new Container();
  app.load(
    createModule((module) => {
      module.single(HeavyToken, () => {
        built += 1;
        return { value: 42 };
      });
    }),
  );

  const getHeavy = app.inject(HeavyToken);
  console.log("not built until called:", built === 0);
  console.log("lazy value:", getHeavy().value, "| built once:", built === 1);
}

// ───────────────────────────────────────────────────────────────────────────
// 6b. Accessors — token-free call sites
// ───────────────────────────────────────────────────────────────────────────
//
// createAccessors(container, spec) turns a name -> token mapping into typed,
// lazy accessors: sync tokens become () => T, async tokens () => Promise<T>.
// Tokens stay a wiring detail; consumers call app.logger() / await app.db().

async function accessors() {
  line("6b. accessors");

  interface Logger {
    log(msg: string): void;
  }
  interface Db {
    ping(): string;
  }

  const LoggerToken = createSyncToken<Logger>("Logger");
  const DbToken = createAsyncToken<Db>("Db");

  const container = new Container();
  container.load(
    createModule((module) => {
      module.single(LoggerToken, () => ({ log: (msg) => console.log(`  [app] ${msg}`) }));
      module.singleAsync(DbToken, async () => {
        await new Promise((res) => setTimeout(res, 10)); // simulate connect()
        return { ping: () => "pong" };
      });
    }),
  );

  const app = createAccessors(container, { logger: LoggerToken, db: DbToken });

  app.logger().log("no tokens at this call site");
  const db = await app.db(); // async member -> promise
  console.log("accessors ping:", db.ping());

  await container.dispose();
}

// ───────────────────────────────────────────────────────────────────────────
// 7. Multiple modules + composition
// ───────────────────────────────────────────────────────────────────────────
//
// Split definitions across modules and load them together. A common layout:
// one module per feature/layer.

function modules() {
  line("7. multiple modules");

  const LoggerToken = createSyncToken<(msg: string) => void>("Logger");
  const MailerToken = createSyncToken<{ send(to: string): string }>("Mailer");

  const infraModule = createModule((module) => {
    module.single(LoggerToken, () => (msg: string) => console.log(`  [infra] ${msg}`));
  });
  const featureModule = createModule((module) => {
    module.single(MailerToken, (resolver) => ({
      send: (to: string) => {
        resolver.get(LoggerToken)(`mail -> ${to}`);
        return `sent:${to}`;
      },
    }));
  });

  const app = new Container();
  app.load(infraModule);
  app.load(featureModule);
  console.log("composed:", app.get(MailerToken).send("a@b.c"));
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Testing — override for mocks
// ───────────────────────────────────────────────────────────────────────────
//
// Load a real module, then load a replacement with { override: true }. Override
// is rejected if the token already has a live instance (resolve nothing first,
// or build a fresh container per test).

function testingOverride() {
  line("8. testing via override");

  interface Clock {
    now(): number;
  }
  const ClockToken = createSyncToken<Clock>("Clock");
  const prodModule = createModule((module) => module.single(ClockToken, () => ({ now: () => Date.now() })));
  const testModule = createModule((module) => module.single(ClockToken, () => ({ now: () => 1234 })));

  const app = new Container();
  app.load(prodModule);
  app.load(testModule, { override: true }); // before any resolve -> allowed
  console.log("overridden clock:", app.get(ClockToken).now() === 1234);

  // Overriding an already-resolved token is rejected:
  const app2 = new Container();
  app2.load(prodModule);
  app2.get(ClockToken); // now in use
  try {
    app2.load(testModule, { override: true });
  } catch (e) {
    console.log("override-in-use rejected:", e instanceof DefinitionInUseError);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 9. Hot-swapping definitions at runtime (unload + load)
// ───────────────────────────────────────────────────────────────────────────

async function hotSwap() {
  line("9. unload + reload");

  const FeatureToken = createSyncToken<string>("Feature");
  const v1Module = createModule((module) => module.single(FeatureToken, () => "v1"));
  const v2Module = createModule((module) => module.single(FeatureToken, () => "v2"));

  const app = new Container();
  app.load(v1Module);
  console.log("before:", app.get(FeatureToken));

  await app.unload(v1Module); // disposes instances, removes definitions
  app.load(v2Module);
  console.log("after reload:", app.get(FeatureToken));
}

// ───────────────────────────────────────────────────────────────────────────
// 10. The guardrails (errors you'll hit if you wire something wrong)
// ───────────────────────────────────────────────────────────────────────────

async function guardrails() {
  line("10. error guardrails");

  // Circular dependency
  {
    const A = createSyncToken<unknown>("A");
    const B = createSyncToken<unknown>("B");
    const app = new Container();
    app.load(
      createModule((module) => {
        module.single(A, (resolver) => ({ b: resolver.get(B) }));
        module.single(B, (resolver) => ({ a: resolver.get(A) }));
      }),
    );
    try {
      app.get(A);
    } catch (e) {
      console.log("circular:", e instanceof CircularDependencyError);
    }
  }

  // Captive dependency: a singleton must not depend on a scoped definition
  // (the scoped instance would be captured for the singleton's whole life).
  {
    const SvcToken = createSyncToken<unknown>("Svc");
    const CtxToken = createSyncToken<unknown>("Ctx");
    const app = new Container();
    app.load(
      createModule((module) => {
        module.single(SvcToken, (resolver) => ({ ctx: resolver.get(CtxToken) }));
        module.scoped(CtxToken, () => ({}));
      }),
    );
    try {
      app.get(SvcToken);
    } catch (e) {
      console.log("captive:", e instanceof CaptiveDependencyError);
    }
  }

  // Shadowing: an ancestor and descendant cannot define the same token.
  {
    const T = createSyncToken<number>("Shadowed");
    const root = new Container();
    const child = root.createScope();
    child.load(createModule((module) => module.single(T, () => 1)));
    try {
      root.load(createModule((module) => module.single(T, () => 2)));
    } catch (e) {
      console.log("shadowing:", e instanceof ShadowedDefinitionError);
    }
  }

  // Lifecycle reentrancy: only one load/unload/dispose per tree at a time.
  // Start a slow async unload, then attempt a concurrent load on the same tree.
  {
    const SlowToken = createAsyncToken<number>("Slow");
    const slowModule = createModule((module) =>
      module.singleAsync(SlowToken, async () => {
        await new Promise((r) => setTimeout(r, 30));
        return 1;
      }),
    );
    const app = new Container();
    app.load(slowModule);
    await app.getAsync(SlowToken); // realize it so unload has something to evict

    const unloading = app.unload(slowModule); // tree-wide lifecycle op, in progress
    unloading.catch(() => {});

    const otherModule = createModule((module) => module.single(createSyncToken<number>("Other"), () => 2));
    try {
      app.load(otherModule); // concurrent lifecycle op on the same tree
      console.log("reentrancy: false (expected rejection)");
    } catch (e) {
      console.log("reentrancy:", e instanceof LifecycleOperationError);
    }
    await unloading;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 11. A realistic app-shaped wiring (per-request scope)
// ───────────────────────────────────────────────────────────────────────────

async function realisticApp() {
  line("11. realistic per-request wiring");

  // App-wide singletons
  interface Config {
    dbUrl: string;
  }
  interface Db {
    queryUser(id: string): { id: string; name: string };
  }
  // Per-request scoped
  interface RequestContext {
    requestId: string;
  }
  interface Handler {
    handle(userId: string): string;
  }

  const ConfigToken = createSyncToken<Config>("Config");
  const DbToken = createSyncToken<Db>("Db");
  const RequestContextToken = createSyncToken<RequestContext>("RequestContext");
  const HandlerToken = createSyncToken<Handler>("Handler");

  const appModule = createModule((module) => {
    module.single(ConfigToken, () => ({ dbUrl: "postgres://..." }));
    module.single(DbToken, (resolver) => {
      const cfg = resolver.get(ConfigToken);
      return { queryUser: (id) => ({ id, name: `user-${id}@${cfg.dbUrl.length}` }) };
    });
  });

  // Handler is scoped because it depends on the per-request context.
  const requestModule = createModule((module) => {
    module.scoped(RequestContextToken, () => ({ requestId: Math.random().toString(36).slice(2, 8) }));
    module.scoped(HandlerToken, (resolver) => {
      const db = resolver.get(DbToken); // singleton, shared
      const ctx = resolver.get(RequestContextToken); // scoped, per request
      return {
        handle: (userId) => {
          const u = db.queryUser(userId);
          return `[req ${ctx.requestId}] ${u.name}`;
        },
      };
    });
  });

  const root = new Container();
  root.load(appModule);

  // Simulate handling two requests, each in its own scope.
  for (const userId of ["1", "2"]) {
    const out = await root.withScope(async (scope) => {
      scope.load(requestModule);
      return scope.get(HandlerToken).handle(userId);
    });
    console.log(out);
  }

  await root.dispose();
}

// ───────────────────────────────────────────────────────────────────────────

async function main() {
  await lifetimes();
  wiring();
  await asyncProviders();
  await scopes();
  await disposal();
  lazyInjection();
  await accessors();
  modules();
  testingOverride();
  await hotSwap();
  await guardrails();
  await realisticApp();
  console.log("\nAll examples ran.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
