import { describe, expect, it } from "vitest";

import { Container, createAsyncToken, createAccessors, createModule, createSyncToken } from "../../src/internal";
import { type AsyncToken, DisposedContainerError, type Accessors, type Token } from "../../src/internal";
import { delay } from "../helpers";

describe("accessors", () => {
  it("sync accessor resolves through the container and honors singleton caching", () => {
    const Db = createSyncToken<{ url: string }>("fDb");
    const c = new Container();
    c.load(createModule((m) => m.single(Db, () => ({ url: "postgres://x" }))));
    const app = createAccessors(c, { db: Db });
    expect(app.db().url).toBe("postgres://x");
    expect(app.db() === c.get(Db), "accessors and direct get share the singleton").toBeTruthy();
  });

  it("async accessor returns a promise and coalesces like getAsync", async () => {
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
    expect(builds, "concurrent accessors calls share one resolution").toBe(1);
    expect(a === b).toBeTruthy();
  });

  it("factory accessor produces a fresh value per call", () => {
    const Id = createSyncToken<number>("fId");
    let n = 0;
    const c = new Container();
    c.load(createModule((m) => m.factory(Id, () => (n += 1))));
    const app = createAccessors(c, { id: Id });
    expect(app.id()).toBe(1);
    expect(app.id()).toBe(2);
  });

  it("accessors bound to a scope resolves scoped instances", async () => {
    const Ctx = createSyncToken<object>("fCtx");
    const root = new Container();
    root.load(createModule((m) => m.scoped(Ctx, () => ({}))));
    const s1 = root.createScope();
    const s2 = root.createScope();
    const f1 = createAccessors(s1, { ctx: Ctx });
    const f2 = createAccessors(s2, { ctx: Ctx });
    expect(f1.ctx() === f1.ctx(), "stable within a scope").toBeTruthy();
    expect(f1.ctx() !== f2.ctx(), "differs across scopes").toBeTruthy();
    await s1.dispose();
    await s2.dispose();
  });

  it("accessors are lazy: accessors may be created before the module is loaded", () => {
    const T = createSyncToken<number>("fLazy");
    const c = new Container();
    const app = createAccessors(c, { t: T });
    c.load(createModule((m) => m.single(T, () => 7)));
    expect(app.t()).toBe(7);
  });

  it("accessors of a disposed container throw", async () => {
    const T = createSyncToken<number>("fDisposed");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    const app = createAccessors(c, { t: T });
    await c.dispose();
    expect(() => app.t()).toThrowError(DisposedContainerError);
  });

  it("accessors object is frozen", () => {
    const T = createSyncToken<number>("fFrozen");
    const c = new Container();
    const app = createAccessors(c, { t: T });
    expect(Object.isFrozen(app)).toBeTruthy();
  });

  it("container.accessors() is equivalent sugar for createAccessors", () => {
    const T = createSyncToken<number>("fMethod");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 41)));
    const app = c.accessors({ answer: T });
    expect(app.answer()).toBe(41);
    expect(Object.isFrozen(app)).toBe(true);
  });

  it("accessors survive destructuring (closures capture the instance, not `this`)", () => {
    const T = createSyncToken<number>("fDestructure");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 5)));
    const { t } = createAccessors(c, { t: T });
    expect(t()).toBe(5);
  });

  it("repeated property access yields the same accessor closure", () => {
    const T = createSyncToken<number>("fStable");
    const c = new Container();
    const app = createAccessors(c, { t: T });
    expect(app.t).toBe(app.t);
  });

  it("accessors types map sync/async members correctly at compile time", () => {
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
    expect(true).toBeTruthy();
  });
});
