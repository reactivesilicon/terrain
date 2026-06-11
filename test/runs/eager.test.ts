import { describe, expect, it } from "vitest";

import { Container, createAsyncToken, createModule, createSyncToken } from "../../src";
import { DisposedContainerError, type SingletonDefinitionOptions } from "../../src";
import { delay } from "../helpers";

describe("eager start", () => {
  it("start() constructs eager singletons before any resolution", async () => {
    const Db = createSyncToken<{ url: string }>("egDb");
    let built = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(
          Db,
          () => {
            built += 1;
            return { url: "db://x" };
          },
          { eager: true },
        ),
      ),
    );
    expect(built, "load alone constructs nothing").toBe(0);
    await c.start();
    expect(built).toBe(1);
    c.get(Db);
    expect(built, "first get() reuses the started instance").toBe(1);
  });

  it("start() awaits eager async singletons", async () => {
    const Conn = createAsyncToken<{ ready: boolean }>("egConn");
    let connected = false;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(
          Conn,
          async () => {
            await delay(10);
            connected = true;
            return { ready: true };
          },
          { eager: true },
        ),
      ),
    );
    await c.start();
    expect(connected, "start() resolves only after async construction finished").toBe(true);
  });

  it("non-eager definitions stay lazy through start()", async () => {
    const Lazy = createSyncToken<number>("egLazy");
    let built = 0;
    const c = new Container();
    c.load(createModule((m) => m.single(Lazy, () => (built += 1))));
    await c.start();
    expect(built).toBe(0);
  });

  it("a failing eager provider rejects start() but does not stop the others", async () => {
    const Bad = createSyncToken<number>("egBad");
    const Good = createSyncToken<number>("egGood");
    let goodBuilt = 0;
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(
          Bad,
          () => {
            throw new Error("boot-boom");
          },
          { eager: true },
        );
        m.single(Good, () => (goodBuilt += 1), { eager: true });
      }),
    );
    let caught: unknown;
    try {
      await c.start();
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof AggregateError, "start() surfaces failures as AggregateError").toBeTruthy();
    expect(goodBuilt, "other eager definitions are still constructed").toBe(1);
  });

  it("start() is idempotent", async () => {
    const T = createSyncToken<number>("egIdem");
    let built = 0;
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => (built += 1), { eager: true })));
    await c.start();
    await c.start();
    expect(built).toBe(1);
  });

  it("override before start() builds the replacement, preserving the test story", async () => {
    const Clock = createSyncToken<{ now(): number }>("egClock");
    const prod = createModule((m) => m.single(Clock, () => ({ now: () => Date.now() }), { eager: true }));
    const fake = createModule((m) => m.single(Clock, () => ({ now: () => 1234 }), { eager: true }));
    const c = new Container();
    c.load(prod);
    c.load(fake, { override: true }); // legal: nothing constructed yet
    await c.start();
    expect(c.get(Clock).now()).toBe(1234);
  });

  it("start() on a disposed container throws", async () => {
    const c = new Container();
    await c.dispose();
    await expect(c.start()).rejects.toThrowError(DisposedContainerError);
  });

  it("an eager option smuggled past the literal check is ignored for factories", async () => {
    const F = createSyncToken<number>("egSmuggled");
    let built = 0;
    // Excess-property checks only fire on object literals; a widened variable
    // compiles. The builder's non-singleton path must never read eager.
    const smuggled: SingletonDefinitionOptions<number> = { eager: true };
    const c = new Container();
    c.load(createModule((m) => m.factory(F, () => (built += 1), smuggled)));
    await c.start();
    expect(built, "start() must never construct factory instances").toBe(0);
  });

  it("eager is rejected on factory and scoped at compile time", () => {
    const F = createSyncToken<number>("egF");
    const S = createSyncToken<number>("egS");
    // Never executed — typecheck:test fails if eager leaks beyond singletons.
    void function compileOnly() {
      createModule((m) => {
        // @ts-expect-error factories cache nothing; eager is meaningless
        m.factory(F, () => 1, { eager: true });
        // @ts-expect-error "eager scoped" has no scope to construct into
        m.scoped(S, () => 1, { eager: true });
      });
    };
    expect(true).toBeTruthy();
  });
});
