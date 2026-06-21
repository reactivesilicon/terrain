import { describe, expect, it } from "vitest";

import { DIError, DisposedContainerError, InvalidEntryNameError } from "../../src";
import { createContainer, createModule } from "../../src/module-composition/composition";
import { delay } from "../helpers";

interface Logger {
  log(msg: string): string;
}
interface Db {
  ping(): string;
}

describe("named modules (spike)", () => {
  it("wires, exposes namespaced accessors, and infers all types", async () => {
    const Core = createModule("Core", (m) =>
      m
        .single("logger", (): Logger => ({ log: (msg) => `[log] ${msg}` }))
        .singleAsync("db", async (): Promise<Db> => {
          await delay(5);
          return { ping: () => "pong" };
        }),
    );

    const app = createContainer({ parts: [Core] });
    const logger: Logger = app.Core.logger();
    expect(logger.log("hi")).toBe("[log] hi");
    const db: Db = await app.Core.db();
    expect(db.ping()).toBe("pong");
    await app.dispose();
  });

  it("providers resolve earlier entries by name, fully typed", () => {
    const Mod = createModule("Mod", (m) =>
      m
        .single("base", () => 2)
        .single("derived", (r) => r.Mod.base() * 21)
        .single("summary", (r) => `${r.Mod.base()}->${r.Mod.derived()}`),
    );
    const app = createContainer({ parts: [Mod] });
    expect(app.Mod.derived()).toBe(42);
    expect(app.Mod.summary()).toBe("2->42");
  });

  it("cross-module wiring works through resolver namespaces", async () => {
    const Core = createModule("Core", (m) =>
      m
        .single("logger", (): Logger => ({ log: (msg) => `core:${msg}` }))
        .singleAsync("db", async (): Promise<Db> => ({ ping: () => "pong" })),
    );
    const Data = createModule("Data", { uses: [Core] }, (m) =>
      m
        .single("repo", (r) => ({ describe: () => r.Core.logger().log("repo") }))
        .singleAsync("health", async (r) => `${r.Core.logger().log("health")}/${(await r.Core.db()).ping()}`),
    );

    const wiredOnly = createContainer({ parts: [Data] }); // Core auto-loads for wiring...
    expect(wiredOnly.Data.repo().describe()).toBe("core:repo");
    expect((wiredOnly as Record<string, unknown>)["Core"]).toBeUndefined(); // ...but is not exposed
    await wiredOnly.dispose();

    const app = createContainer({ parts: [Data, Core] }); // exposure is explicit
    expect(app.Data.repo().describe()).toBe("core:repo");
    expect(await app.Data.health()).toBe("core:health/pong");
    expect(app.Core.logger().log("direct")).toBe("core:direct");
    await app.dispose();
  });

  it("a module shared by two importers loads once", () => {
    let built = 0;
    const Core = createModule("Core", (m) => m.single("counter", () => (built += 1)));
    const A = createModule("A", { uses: [Core] }, (m) => m.single("a", (r) => r.Core.counter()));
    const B = createModule("B", { uses: [Core] }, (m) => m.single("b", (r) => r.Core.counter()));

    const app = createContainer({ parts: [A, B] });
    expect(app.A.a()).toBe(1);
    expect(app.B.b()).toBe(1);
    expect(built).toBe(1);
  });

  it("factory accessors produce fresh values; scoped views cache per scope", async () => {
    let stamps = 0;
    const Mod = createModule("Mod", (m) =>
      m.factory("stamp", () => (stamps += 1)).scoped("ctx", () => ({ id: Math.floor(stamps * 1000) + stamps })),
    );

    const app = createContainer({ parts: [Mod] });
    expect(app.Mod.stamp()).toBe(1);
    expect(app.Mod.stamp()).toBe(2);

    const s1 = app.scope();
    const s2 = app.scope();
    expect(s1.Mod.ctx()).toBe(s1.Mod.ctx()); // stable within a scope
    expect(s1.Mod.ctx()).not.toBe(s2.Mod.ctx()); // distinct across scopes
    await s1.dispose();
    await s2.dispose();
    await app.dispose();
  });

  it("async lifetimes, resolver getAsync, and has() all work by name", async () => {
    let mints = 0;
    const Mod = createModule("Mod", (m) =>
      m
        .singleAsync("db", async (): Promise<Db> => {
          await delay(2);
          return { ping: () => "pong" };
        })
        .factoryAsync("mint", async () => (mints += 1))
        .single("region", () => "eu-1")
        .scopedAsync("session", async (r) => ({
          db: await r.Mod.db(),
          region: r.Mod.region(),
        })),
    );

    const app = createContainer({ parts: [Mod] });
    expect(await app.Mod.mint()).toBe(1);
    expect(await app.Mod.mint()).toBe(2); // factory: fresh per call

    const scope = app.scope();
    const session = await scope.Mod.session();
    expect(session.db.ping()).toBe("pong");
    expect(session.region).toBe("eu-1");
    expect(await scope.Mod.session()).toBe(session); // scoped: cached per scope
    await scope.dispose();
    await app.dispose();
  });

  it("callback scope() auto-disposes and returns the body result", async () => {
    let disposed = 0;
    const Mod = createModule("Mod", (m) =>
      m.scoped("ctx", () => ({ id: 7 }), {
        dispose: () => {
          disposed += 1;
        },
      }),
    );
    const app = createContainer({ parts: [Mod] });

    const result = await app.scope(async (req) => req.Mod.ctx().id);
    expect(result).toBe(7);
    expect(disposed, "scope disposed even though nobody called dispose()").toBe(1);

    // Body errors propagate, and the scope is still torn down.
    const failure = await app
      .scope((req) => {
        req.Mod.ctx(); // construct, then fail — teardown must still run
        throw new Error("body-boom");
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((failure as Error).message).toBe("body-boom");
    expect(disposed).toBe(2);
    await app.dispose();
  });

  it("scopes nest: a request scope opens transaction sub-scopes", async () => {
    const Mod = createModule("Mod", (m) => m.scoped("ctx", () => ({})));
    const app = createContainer({ parts: [Mod] });
    const request = app.scope();
    const requestCtx = request.Mod.ctx();

    await request.scope(async (tx) => {
      expect(tx.Mod.ctx()).not.toBe(requestCtx); // its own copy, one level down
      expect(tx.Mod.ctx()).toBe(tx.Mod.ctx()); // stable within the sub-scope
    });
    expect(request.Mod.ctx()).toBe(requestCtx); // request scope unaffected
    await request.dispose();
    await app.dispose();
  });

  it("two versions of a same-named module coexist when used by different importers", () => {
    const CoreV1 = createModule("Core", (m) => m.single("version", () => "v1"));
    const CoreV2 = createModule("Core", (m) => m.single("version", () => "v2"));
    const A = createModule("A", { uses: [CoreV1] }, (m) => m.single("seen", (r) => r.Core.version()));
    const B = createModule("B", { uses: [CoreV2] }, (m) => m.single("seen", (r) => r.Core.version()));

    // Each importer's r.Core resolves against ITS OWN dependency — npm-style
    // version isolation, with both Cores loaded under distinct tokens.
    const app = createContainer({ parts: [A, B] });
    expect(app.A.seen()).toBe("v1");
    expect(app.B.seen()).toBe("v2");

    // Exposing both identically-named modules is the only conflict.
    expect(() => createContainer({ parts: [A, B, CoreV1, CoreV2] })).toThrowError(/Duplicate module name 'Core'/);
  });

  it("eager + start() constructs at boot; disposers run on dispose", async () => {
    const events: string[] = [];
    const Mod = createModule("Mod", (m) =>
      m.singleAsync(
        "conn",
        async () => {
          await delay(5);
          events.push("connected");
          return { close: () => events.push("closed") };
        },
        { eager: true, dispose: (c) => void c.close() },
      ),
    );

    const app = createContainer({ parts: [Mod] });
    expect(events).toEqual([]);
    await app.start();
    expect(events).toEqual(["connected"]);
    await app.dispose();
    expect(events).toEqual(["connected", "closed"]);
  });

  it("createContainer threads onDisposeError to observe orphan disposal failures", async () => {
    let hookError: unknown = null;
    const Infra = createModule("Infra", (m) =>
      m.singleAsync(
        "resource",
        async () => {
          await delay(30);
          return {
            close: () => {
              throw new Error("orphan-dispose");
            },
          };
        },
        { dispose: (resource) => resource.close() },
      ),
    );
    const app = createContainer({
      options: {
        onDisposeError: (error) => {
          hookError = error;
        },
      },
      parts: [Infra],
    });

    const pendingResource = app.Infra.resource();
    pendingResource.catch(() => {});
    await delay(5);
    await app.dispose();
    await delay(10);

    expect(hookError instanceof Error && hookError.message === "orphan-dispose").toBeTruthy();
  });

  it("accessors of a disposed container throw", async () => {
    const Mod = createModule("Mod", (m) => m.single("x", () => 1));
    const app = createContainer({ parts: [Mod] });
    await app.dispose();
    expect(() => app.Mod.x()).toThrowError(DisposedContainerError);
  });

  it("views do not expose the engine container or tokens", async () => {
    const Mod = createModule("Mod", (m) => m.single("x", () => 1));
    const app = createContainer({ parts: [Mod] });
    expect((app as Record<string, unknown>)["container"], "no engine escape hatch on the app view").toBe(undefined);
    const requestScope = app.scope();
    expect((requestScope as Record<string, unknown>)["container"], "none on scope views either").toBe(undefined);
    // @ts-expect-error container is not part of the view type
    void app.container;
    await requestScope.dispose();
    await app.dispose();
  });

  it("entry names must be valid identifiers, so every entry is dot-accessible", () => {
    const attempt = () => createModule("Mod", (m) => m.single("my entry" as never, () => 1));
    expect(attempt).toThrowError(InvalidEntryNameError);
    expect(attempt).toThrowError(/must be a valid identifier/);
    expect(() => createModule("Mod", (m) => m.single("9lives" as never, () => 1))).toThrowError(InvalidEntryNameError);
    // Layer guards are framework errors, catchable like the engine's.
    try {
      attempt();
    } catch (e) {
      expect(e).toBeInstanceOf(DIError);
    }
  });

  it("duplicate accessor names within a module are rejected at build time", () => {
    expect(() => createModule("Dup", (m) => m.single("x", () => 1).single("x", () => 2))).toThrowError(
      /Duplicate accessor name 'x'/,
    );
  });

  it("duplicate module names in one container are rejected", () => {
    const A1 = createModule("Same", (m) => m.single("x", () => 1));
    const A2 = createModule("Same", (m) => m.single("y", () => 2));
    expect(() => createContainer({ parts: [A1, A2] })).toThrowError(/Duplicate module name 'Same'/);
  });

  it("accessors survive destructuring, on views and inside providers", async () => {
    const Core = createModule("Core", (m) => m.single("logger", (): Logger => ({ log: (msg) => `c:${msg}` })));
    const Data = createModule("Data", { uses: [Core] }, (m) =>
      m.single("repo", (r) => {
        const { logger } = r.Core; // detached accessor inside a provider
        return { tag: logger().log("repo") };
      }),
    );
    const app = createContainer({ parts: [Data, Core] });
    const { logger } = app.Core; // detached accessor on the view
    expect(logger().log("view")).toBe("c:view");
    expect(app.Data.repo().tag).toBe("c:repo");
    const first = app.Core.logger;
    expect(app.Core.logger).toBe(first); // lazy accessor is created once, then cached
    await app.dispose();
  });

  it("a foreign object smuggled in as a module fails with a clear error", () => {
    const impostor = { name: "Fake" } as never;
    expect(() => createContainer({ parts: [impostor] })).toThrowError(/not a module created by createModule/);
    expect(() => createModule("Importer", { uses: [impostor] }, (m) => m.single("x", () => 1))).toThrowError(
      /not a module created by createModule/,
    );
  });

  it("a structural look-alike with Map-shaped internals is still rejected (identity, not shape)", () => {
    const lookAlike = {
      name: "Fake",
      definitionsByLocalName: new Map(),
      uses: [],
      override: () => ({}),
    } as never;
    expect(() => createContainer({ parts: [lookAlike] })).toThrowError(/not a module created by createModule/);
    const overrideLookAlike = { name: "Fake", replacements: new Map() } as never;
    expect(() => createContainer({ parts: [overrideLookAlike] })).toThrowError(/not a module created by createModule/);
  });

  it("modules and overrides expose nothing internal: no tokens, no engine module, no wiring", () => {
    const Mod = createModule("Mod", (m) => m.single("x", () => 1));
    const asRecord = Mod as unknown as Record<string, unknown>;
    expect(asRecord["tokenModule"], "engine module must be unreachable").toBe(undefined);
    expect(asRecord["definitionsByLocalName"], "definitions (and their tokens) must be unreachable").toBe(undefined);
    expect(asRecord["uses"], "wiring must be unreachable").toBe(undefined);
    expect(Object.isFrozen(Mod)).toBe(true);

    const Fake = Mod.override((o) => o.with("x", () => 2));
    const fakeAsRecord = Fake as unknown as Record<string, unknown>;
    expect(fakeAsRecord["replacements"]).toBe(undefined);
    expect(fakeAsRecord["target"]).toBe(undefined);
    expect(Object.isFrozen(Fake)).toBe(true);
  });

  it("namespaced accessor objects are frozen", () => {
    const Mod = createModule("Mod", (m) => m.single("x", () => 1));
    const app = createContainer({ parts: [Mod] });
    expect(Object.isFrozen(app.Mod)).toBe(true);
    expect(Object.isFrozen(app)).toBe(true);
  });

  it("entries named like accessor internals resolve to their values", () => {
    const M = createModule("M", (m) =>
      m
        .single("source", () => "S")
        .single("accessorCache", () => "C")
        .single("toString", () => "T"),
    );
    const app = createContainer({ parts: [M] });

    expect(app.M.source()).toBe("S");
    expect(app.M.accessorCache()).toBe("C");
    expect(app.M.toString()).toBe("T");
  });

  it("a used module's entries are not re-exported by the importer", () => {
    const Core = createModule("Core", (m) => m.single("logger", (): Logger => ({ log: (s) => s })));
    const Data = createModule("Data", { uses: [Core] }, (m) => m.single("repo", () => ({})));
    const app = createContainer({ parts: [Data] });
    expect((app.Data as Record<string, unknown>)["logger"]).toBeUndefined();
  });

  it("module names must be PascalCase so they can never shadow the view API", () => {
    // The runtime backstop (typed callers are stopped at compile time below).
    expect(() => createModule("scope" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
    expect(() => createModule("dispose" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
    expect(() => createModule("9Lives" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
    expect(() => createModule("My Mod" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
  });

  it("compile-time: lowercase module names are rejected", () => {
    void function compileOnly() {
      // @ts-expect-error module names must be PascalCase
      createModule("infra", (m) => m.single("x", () => 1));
      // @ts-expect-error a module literally named after a view method cannot exist
      createModule("start", (m) => m.single("x", () => 1));
    };
    expect(true).toBe(true);
  });

  it("using a module that bears the importer's own name is rejected", () => {
    const Impostor = createModule("Importer", (m) => m.single("x", () => 1));
    expect(() => createModule("Importer", { uses: [Impostor] }, (m) => m.single("y", () => 2))).toThrowError(
      /cannot use a module bearing its own name/,
    );
  });

  it("two used modules with the same name are rejected", () => {
    const A1 = createModule("Same", (m) => m.single("x", () => 1));
    const A2 = createModule("Same", (m) => m.single("y", () => 2));
    expect(() => createModule("Importer", { uses: [A1, A2] }, (m) => m.single("z", () => 3))).toThrowError(
      /Duplicate used module name 'Same'/,
    );
  });

  it("an override replaces a provider transparently for all consumers", async () => {
    let realRan = 0;
    const Infra = createModule("Infra", (m) =>
      m.single("logger", (): Logger => {
        realRan += 1;
        return { log: (msg) => `real:${msg}` };
      }),
    );
    const Domain = createModule("Domain", { uses: [Infra] }, (m) =>
      m.single("greet", (r) => ({ run: () => r.Infra.logger().log("hi") })),
    );
    const FakeInfra = Infra.override((o) => o.with("logger", (): Logger => ({ log: (msg) => `fake:${msg}` })));

    // Infra is not even exposed — overriding transitive wiring works.
    const app = createContainer({ parts: [Domain, FakeInfra] });
    expect(app.Domain.greet().run()).toBe("fake:hi");
    expect(realRan, "the real provider must never construct").toBe(0);
    await app.dispose();
  });

  it("override eager interplay: the fake constructs at start(), the real never connects", async () => {
    const events: string[] = [];
    const Infra = createModule("Infra", (m) =>
      m.singleAsync(
        "db",
        async (): Promise<Db> => {
          events.push("real-connect");
          return { ping: () => "real" };
        },
        { eager: true },
      ),
    );
    const FakeInfra = Infra.override((o) =>
      o.withAsync(
        "db",
        async (): Promise<Db> => {
          events.push("fake-connect");
          return { ping: () => "fake" };
        },
        { eager: true, dispose: () => void events.push("fake-closed") },
      ),
    );
    const app = createContainer({ parts: [Infra, FakeInfra] });
    await app.start();
    expect(events).toEqual(["fake-connect"]);
    expect((await app.Infra.db()).ping()).toBe("fake");
    await app.dispose();
    expect(events).toEqual(["fake-connect", "fake-closed"]);
  });

  it("override keeps the original lifetime: a scoped entry stays scoped", async () => {
    const Mod = createModule("Mod", (m) => m.scoped("ctx", () => ({ kind: "real" })));
    const Fake = Mod.override((o) => o.with("ctx", () => ({ kind: "fake" })));
    const app = createContainer({ parts: [Mod, Fake] });
    const s1 = app.scope();
    const s2 = app.scope();
    expect(s1.Mod.ctx().kind).toBe("fake");
    expect(s1.Mod.ctx()).toBe(s1.Mod.ctx());
    expect(s1.Mod.ctx()).not.toBe(s2.Mod.ctx());
    await s1.dispose();
    await s2.dispose();
    await app.dispose();
  });

  it("an override provider may resolve the module's other entries", () => {
    const Mod = createModule("Mod", (m) => m.single("base", () => 10).single("derived", (r) => r.Mod.base() * 2));
    const Fake = Mod.override((o) => o.with("derived", (r) => r.Mod.base() + 1));
    const app = createContainer({ parts: [Mod, Fake] });
    expect(app.Mod.derived()).toBe(11);
  });

  it("override misuse is rejected loudly", () => {
    const Mod = createModule("Mod", (m) => m.single("x", () => 1).scoped("ctx", () => ({})));
    // unused override (target not in the wiring)
    const Other = createModule("Other", (m) => m.single("y", () => 2));
    const fake = Mod.override((o) => o.with("x", () => 9));
    expect(() => createContainer({ parts: [Other, fake] })).toThrowError(/not part of this container's wiring/);
    // empty override
    expect(() => Mod.override((o) => o)).toThrowError(/replaces nothing/);
    // duplicate replacement of one entry
    expect(() => Mod.override((o) => o.with("x", () => 1).with("x", () => 2))).toThrowError(
      /already replaces entry 'x'/,
    );
    // eager on a non-singleton original
    expect(() => Mod.override((o) => o.with("ctx", () => ({}), { eager: true } as never))).toThrowError(
      /cannot be eager/,
    );
    // runtime backstops for untyped callers (compile errors otherwise)
    expect(() => Mod.override((o) => o.with("ghost" as never, (() => 1) as never))).toThrowError(
      /unknown entry 'ghost'/,
    );
    expect(() => Mod.override((o) => o.withAsync("x" as never, (async () => 1) as never))).toThrowError(
      /is sync; use the matching override method/,
    );
  });

  it("async factory and scoped entries can be overridden, lifetimes preserved", async () => {
    let fakes = 0;
    const Mod = createModule("Mod", (m) =>
      m.factoryAsync("mint", async () => -1).scopedAsync("session", async () => ({ kind: "real" })),
    );
    const Fake = Mod.override((o) =>
      o.withAsync("mint", async () => (fakes += 1)).withAsync("session", async () => ({ kind: "fake" })),
    );
    const app = createContainer({ parts: [Mod, Fake] });
    expect(await app.Mod.mint()).toBe(1);
    expect(await app.Mod.mint()).toBe(2); // factory: fresh per call
    const scope = app.scope();
    const session = await scope.Mod.session();
    expect(session.kind).toBe("fake");
    expect(await scope.Mod.session()).toBe(session); // scoped: cached per scope
    await scope.dispose();
    await app.dispose();
  });

  it("compile-time: overrides are constrained by the original module", () => {
    const Mod = createModule("Mod", (m) =>
      m.single("count", () => 1).singleAsync("db", async (): Promise<Db> => ({ ping: () => "p" })),
    );
    void function compileOnly() {
      Mod.override((o) =>
        o
          // @ts-expect-error unknown entry cannot be overridden
          .with("nope", () => 1)
          // @ts-expect-error value type must match the original
          .with("count", () => "string")
          // @ts-expect-error async entries need withAsync
          .with("db", () => ({ ping: () => "p" })),
      );
    };
    expect(true).toBe(true);
  });

  it("compile-time: the name-first surface rejects misuse", () => {
    const Core = createModule("Core", (m) =>
      m
        .single("logger", (): Logger => ({ log: (s) => s }))
        .singleAsync("db", async (): Promise<Db> => ({ ping: () => "pong" })),
    );
    // Never executed — typecheck:test fails if any of these stops erroring.
    void function compileOnly() {
      createModule("T1", (m) =>
        m
          .single("a", (r) => {
            // @ts-expect-error forward reference: "b" is not registered yet
            r.T1.b;
            return 1;
          })
          .single("b", () => 2),
      );
      createModule("T2", { uses: [Core] }, (m) =>
        m.single("svc", (r) => {
          // @ts-expect-error a sync provider sees no async entries of a used module
          r.Core.db;
          // @ts-expect-error an entry cannot reference itself (not registered yet)
          r.T2.svc;
          return r.Core.logger();
        }),
      );
      createModule("T3", (m) =>
        m.single("ok", (r) => {
          // @ts-expect-error no uses declared: foreign namespaces are invisible
          r.Core;
          void r;
          return 1;
        }),
      );
      const app = createContainer({ parts: [Core] });
      // @ts-expect-error sync accessor does not return a promise
      const bad: Promise<Logger> = app.Core.logger();
      // @ts-expect-error unknown accessor name
      app.Core.nope();
      // @ts-expect-error unknown module namespace
      app.Nope;
      void bad;
    };
    expect(true).toBe(true);
  });

  it("late resolution through a stashed named resolver fails loudly after unload", async () => {
    // The engine's guarantees flow through: the named layer is a facade.
    const Core = createModule("Core", (m) => m.single("x", () => 1));
    const Lazy = createModule("Lazy", { uses: [Core] }, (m) => m.single("poker", (r) => ({ poke: () => r.Core.x() })));
    const app = createContainer({ parts: [Lazy] });
    const poker = app.Lazy.poker();
    expect(poker.poke()).toBe(1);
    await app.dispose();
    expect(() => poker.poke()).toThrowError(DisposedContainerError);
  });
});
