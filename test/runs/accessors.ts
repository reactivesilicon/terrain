import { Container, createAsyncToken, createAccessors, createModule, createSyncToken } from "../../src";
import { type AsyncToken, DisposedContainerError, type Accessors, type Token } from "../../src";
import { suite, assert, assertEqual, assertThrows, isInstance, delay } from "../harness";

suite("accessors", (test) => {
  test("sync accessor resolves through the container and honors singleton caching", () => {
    const Db = createSyncToken<{ url: string }>("fDb");
    const c = new Container();
    c.load(createModule((m) => m.single(Db, () => ({ url: "postgres://x" }))));
    const app = createAccessors(c, { db: Db });
    assertEqual(app.db().url, "postgres://x");
    assert(app.db() === c.get(Db), "accessors and direct get share the singleton");
  });

  test("async accessor returns a promise and coalesces like getAsync", async () => {
    const Cfg = createAsyncToken<{ env: string }>("fCfg");
    let builds = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(Cfg, async () => {
          builds += 1;
          await delay(10);
          return { env: "prod" };
        }),
      ),
    );
    const app = createAccessors(c, { cfg: Cfg });
    const [a, b] = await Promise.all([app.cfg(), app.cfg()]);
    assertEqual(builds, 1, "concurrent accessors calls share one resolution");
    assert(a === b);
  });

  test("factory accessor produces a fresh value per call", () => {
    const Id = createSyncToken<number>("fId");
    let n = 0;
    const c = new Container();
    c.load(createModule((m) => m.factory(Id, () => (n += 1))));
    const app = createAccessors(c, { id: Id });
    assertEqual(app.id(), 1);
    assertEqual(app.id(), 2);
  });

  test("accessors bound to a scope resolves scoped instances", async () => {
    const Ctx = createSyncToken<object>("fCtx");
    const root = new Container();
    root.load(createModule((m) => m.scoped(Ctx, () => ({}))));
    const s1 = root.createScope();
    const s2 = root.createScope();
    const f1 = createAccessors(s1, { ctx: Ctx });
    const f2 = createAccessors(s2, { ctx: Ctx });
    assert(f1.ctx() === f1.ctx(), "stable within a scope");
    assert(f1.ctx() !== f2.ctx(), "differs across scopes");
    await s1.dispose();
    await s2.dispose();
  });

  test("accessors are lazy: accessors may be created before the module is loaded", () => {
    const T = createSyncToken<number>("fLazy");
    const c = new Container();
    const app = createAccessors(c, { t: T });
    c.load(createModule((m) => m.single(T, () => 7)));
    assertEqual(app.t(), 7);
  });

  test("accessors of a disposed container throw", async () => {
    const T = createSyncToken<number>("fDisposed");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    const app = createAccessors(c, { t: T });
    await c.dispose();
    await assertThrows(() => app.t(), isInstance(DisposedContainerError));
  });

  test("accessors object is frozen", () => {
    const T = createSyncToken<number>("fFrozen");
    const c = new Container();
    const app = createAccessors(c, { t: T });
    assert(Object.isFrozen(app));
  });

  test("accessors types map sync/async members correctly at compile time", () => {
    // Never executed — typecheck:test fails if any of these stops behaving.
    void function compileOnly(f: Accessors<{ db: Token<number>; cfg: AsyncToken<string> }>) {
      const n: number = f.db();
      const p: Promise<string> = f.cfg();
      // @ts-expect-error an async member returns a promise, not the value
      const s: string = f.cfg();
      // @ts-expect-error unknown member
      f.nope();
      void n;
      void p;
      void s;
    };
    assert(true);
  });
});
