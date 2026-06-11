import { describe, expect, it } from "vitest";

import { Container, createModule, createAsyncToken, createSyncToken } from "../../src";
import {
  DefinitionInUseError,
  DisposedContainerError,
  DuplicateDefinitionError,
  LifecycleOperationError,
  ModuleOwnershipError,
} from "../../src";
import { delay, ignore } from "../helpers";

describe("lifecycle: load", () => {
  it("duplicate definition is rejected without override", async () => {
    const T = createSyncToken<number>("dup");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    expect(() => c.load(createModule((m) => m.single(T, () => 2)))).toThrowError(DuplicateDefinitionError);
  });

  it("load is transactional: a failing entry applies nothing", async () => {
    const A = createSyncToken<number>("txA");
    const B = createSyncToken<number>("txB");
    const c = new Container();
    c.load(createModule((m) => m.single(B, () => 99))); // B already present
    expect(() =>
      c.load(
        createModule((m) => {
          m.single(A, () => 1);
          m.single(B, () => 2); // duplicate -> whole load must abort
        }),
      ),
    ).toThrowError(DuplicateDefinitionError);
    expect(c.has(A), "A must not have been partially registered").toBe(false);
    expect(c.get(B), "existing B must be untouched").toBe(99);
  });

  it("override before use replaces the definition", () => {
    const T = createSyncToken<number>("ovOk");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    c.load(
      createModule((m) => m.single(T, () => 2)),
      { override: true },
    );
    expect(c.get(T)).toBe(2);
  });

  it("override of an in-use token is rejected", async () => {
    const T = createSyncToken<number>("ovUsed");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    c.get(T);
    expect(() =>
      c.load(
        createModule((m) => m.single(T, () => 2)),
        { override: true },
      ),
    ).toThrowError(DefinitionInUseError);
  });

  it("override blocked by an in-flight async factory", async () => {
    const T = createAsyncToken<number>("ovFactory");
    const c = new Container();
    c.load(
      createModule((m) =>
        m.factoryAsync(T, async () => {
          await delay(40);
          return 1;
        }),
      ),
    );
    const p = ignore(c.getAsync(T));
    await delay(5);
    expect(() =>
      c.load(
        createModule((m) => m.factoryAsync(T, async () => 2)),
        { override: true },
      ),
    ).toThrowError(DefinitionInUseError);
    await p;
  });
});

describe("lifecycle: unload", () => {
  it("unload removes definitions and disposes instances", async () => {
    const T = createSyncToken<{ dispose(): void }>("ul");
    let disposed = 0;
    const mod = createModule((m) =>
      m.single(T, () => ({ dispose: () => (disposed += 1) }), { dispose: (x) => x.dispose() }),
    );
    const c = new Container();
    c.load(mod);
    c.get(T);
    await c.unload(mod);
    expect(disposed).toBe(1);
    expect(c.has(T)).toBe(false);
  });

  it("unload rejects a module not owned by the container", async () => {
    const T = createSyncToken<number>("ulOwn");
    const mod = createModule((m) => m.single(T, () => 1));
    const root = new Container();
    root.load(mod);
    const scope = root.createScope();
    await expect(scope.unload(mod)).rejects.toThrowError(ModuleOwnershipError);
  });

  it("unload disposes a scoped instance cached in a child scope", async () => {
    const T = createSyncToken<{ dispose(): void }>("ulChild");
    let disposed = 0;
    const mod = createModule((m) =>
      m.scoped(T, () => ({ dispose: () => (disposed += 1) }), { dispose: (x) => x.dispose() }),
    );
    const root = new Container();
    root.load(mod);
    const scope = root.createScope();
    scope.get(T);
    await root.unload(mod);
    expect(disposed).toBe(1);
  });

  it("unload disposes in reverse creation order", async () => {
    const Db = createSyncToken<{ dispose(): void }>("ulDb");
    const Repo = createSyncToken<{ dispose(): void }>("ulRepo");
    const order: string[] = [];
    const mod = createModule((m) => {
      m.single(Db, () => ({ dispose: () => order.push("db") }), { dispose: (x) => x.dispose() });
      m.single(
        Repo,
        (r) => {
          r.get(Db);
          return { dispose: () => order.push("repo") };
        },
        { dispose: (x) => x.dispose() },
      );
    });
    const c = new Container();
    c.load(mod);
    c.get(Repo);
    await c.unload(mod);
    expect(order.join(",")).toBe("repo,db");
  });

  it("unload surfaces disposal failures via AggregateError but still cleans up", async () => {
    const T = createSyncToken<{ dispose(): void }>("ulFail");
    const mod = createModule((m) =>
      m.single(
        T,
        () => ({
          dispose: () => {
            throw new Error("boom");
          },
        }),
        { dispose: (x) => x.dispose() },
      ),
    );
    const c = new Container();
    c.load(mod);
    c.get(T);
    let threw = false;
    try {
      await c.unload(mod);
    } catch (e) {
      threw = e instanceof AggregateError;
    }
    expect(threw, "expected AggregateError").toBeTruthy();
    expect(c.has(T), "definition must still be removed").toBe(false);
  });

  it("a token mid-unload cannot be re-resolved by an in-flight provider", async () => {
    // A (in module modA) depends on B (in module modB). While A's async provider
    // is parked, we unload ONLY modB. A then resumes and tries to resolve B; the
    // unload gate must make that fail rather than rebuild/re-cache B. A itself is
    // not being unloaded, so its provider runs to completion.
    const A = createAsyncToken<{ b: { tag: string } | null }>("ulA");
    const B = createAsyncToken<{ tag: string }>("ulB");
    let bResolveError: unknown = null;
    let bBuilds = 0;
    const modB = createModule((m) => {
      m.singleAsync(B, async () => {
        bBuilds += 1;
        return { tag: "B" };
      });
    });
    const modA = createModule((m) => {
      m.singleAsync(A, async (r) => {
        await delay(40);
        try {
          return { b: await r.getAsync(B) };
        } catch (e) {
          bResolveError = e;
          return { b: null };
        }
      });
    });
    const c = new Container();
    c.load(modB);
    c.load(modA);
    await c.getAsync(B); // prime B so it is cached
    const buildsAfterPrime = bBuilds;
    const pa = c.getAsync(A); // in flight, parked on delay(40)
    await delay(5);
    await c.unload(modB); // unload B while A is parked
    const a = await pa; // A completes (it caught the failed B resolution)
    expect(bResolveError !== null, "A's resolution of B during unload must have failed").toBeTruthy();
    expect(a.b).toBe(null);
    expect(bBuilds, "B must not be rebuilt during unload").toBe(buildsAfterPrime);
  });
});

describe("lifecycle: tree-wide locking", () => {
  it("concurrent load during in-progress unload is rejected", async () => {
    const T = createAsyncToken<number>("lkT");
    const mod = createModule((m) =>
      m.singleAsync(T, async () => {
        await delay(30);
        return 1;
      }),
    );
    const c = new Container();
    c.load(mod);
    await c.getAsync(T);
    const u = ignore(c.unload(mod));
    expect(() => c.load(createModule((m) => m.single(createSyncToken<number>("lkOther"), () => 2)))).toThrowError(
      LifecycleOperationError,
    );
    await u;
  });

  it("child load is blocked while a root unload runs (tree-wide)", async () => {
    const T = createAsyncToken<number>("lkRoot");
    const mod = createModule((m) =>
      m.singleAsync(T, async () => {
        await delay(30);
        return 1;
      }),
    );
    const root = new Container();
    const child = root.createScope();
    root.load(mod);
    await root.getAsync(T);
    const u = ignore(root.unload(mod));
    expect(() => child.load(createModule((m) => m.single(createSyncToken<number>("lkChild"), () => 2)))).toThrowError(
      LifecycleOperationError,
    );
    await u;
  });

  it("dispose during an in-progress unload is rejected", async () => {
    const T = createAsyncToken<number>("lkDisp");
    const mod = createModule((m) =>
      m.singleAsync(T, async () => {
        await delay(30);
        return 1;
      }),
    );
    const c = new Container();
    c.load(mod);
    await c.getAsync(T);
    const u = ignore(c.unload(mod));
    await expect(c.dispose()).rejects.toThrowError(LifecycleOperationError);
    await u;
  });

  it("ownership: a parent disposing while a child unloads does not orphan the child", async () => {
    const CT = createAsyncToken<{ dispose(): void }>("ownChild");
    const cm = createModule((m) =>
      m.singleAsync(
        CT,
        async () => {
          await delay(30);
          return { dispose: () => {} };
        },
        { dispose: (x) => x.dispose() },
      ),
    );
    const root = new Container();
    const child = root.createScope();
    child.load(cm);
    await child.getAsync(CT);
    const unloading = ignore(child.unload(cm));
    // root.dispose must reject (tree busy) rather than silently orphan the child.
    const outcome = await root
      .dispose()
      .then(() => "ok")
      .catch((e) => (e instanceof LifecycleOperationError ? "rejected" : "other"));
    await unloading;
    expect(outcome).toBe("rejected");
    // Once the unload finishes, the tree can be disposed cleanly.
    await root.dispose();
    await expect(child.getAsync(CT)).rejects.toThrowError(DisposedContainerError);
  });
});
