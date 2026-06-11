import { Container, createAsyncToken, createModule, createSyncToken } from "../../src";
import { DisposedContainerError, type SingletonDefinitionOptions } from "../../src";
import { suite, assert, assertEqual, assertThrows, isInstance, delay } from "../harness";

suite("eager start", (test) => {
  test("start() constructs eager singletons before any resolution", async () => {
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
    assertEqual(built, 0, "load alone constructs nothing");
    await c.start();
    assertEqual(built, 1);
    c.get(Db);
    assertEqual(built, 1, "first get() reuses the started instance");
  });

  test("start() awaits eager async singletons", async () => {
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
    assertEqual(connected, true, "start() resolves only after async construction finished");
  });

  test("non-eager definitions stay lazy through start()", async () => {
    const Lazy = createSyncToken<number>("egLazy");
    let built = 0;
    const c = new Container();
    c.load(createModule((m) => m.single(Lazy, () => (built += 1))));
    await c.start();
    assertEqual(built, 0);
  });

  test("a failing eager provider rejects start() but does not stop the others", async () => {
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
    assert(caught instanceof AggregateError, "start() surfaces failures as AggregateError");
    assertEqual(goodBuilt, 1, "other eager definitions are still constructed");
  });

  test("start() is idempotent", async () => {
    const T = createSyncToken<number>("egIdem");
    let built = 0;
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => (built += 1), { eager: true })));
    await c.start();
    await c.start();
    assertEqual(built, 1);
  });

  test("override before start() builds the replacement, preserving the test story", async () => {
    const Clock = createSyncToken<{ now(): number }>("egClock");
    const prod = createModule((m) => m.single(Clock, () => ({ now: () => Date.now() }), { eager: true }));
    const fake = createModule((m) => m.single(Clock, () => ({ now: () => 1234 }), { eager: true }));
    const c = new Container();
    c.load(prod);
    c.load(fake, { override: true }); // legal: nothing constructed yet
    await c.start();
    assertEqual(c.get(Clock).now(), 1234);
  });

  test("start() on a disposed container throws", async () => {
    const c = new Container();
    await c.dispose();
    await assertThrows(() => c.start(), isInstance(DisposedContainerError));
  });

  test("an eager option smuggled past the literal check is ignored for factories", async () => {
    const F = createSyncToken<number>("egSmuggled");
    let built = 0;
    // Excess-property checks only fire on object literals; a widened variable
    // compiles. The builder's non-singleton path must never read eager.
    const smuggled: SingletonDefinitionOptions<number> = { eager: true };
    const c = new Container();
    c.load(createModule((m) => m.factory(F, () => (built += 1), smuggled)));
    await c.start();
    assertEqual(built, 0, "start() must never construct factory instances");
  });

  test("eager is rejected on factory and scoped at compile time", () => {
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
    assert(true);
  });
});
