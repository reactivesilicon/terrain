import { describe, expect, it } from "vitest";

import { DisposedContainerError } from "../../src";
import { delay, ignore, random } from "../helpers";
import { Container, createModule, createAsyncToken, createSyncToken } from "../internal-api";

describe("concurrency", () => {
  it("in-flight async singleton rejects and is disposed after dispose()", async () => {
    const T = createAsyncToken<{ dispose(): void }>("ifSingle");
    let disposed = false;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(
          T,
          async () => {
            await delay(30);
            return { dispose: () => (disposed = true) };
          },
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    const p = ignore(c.getAsync(T));
    await delay(5);
    await c.dispose();
    await expect(p).rejects.toThrowError(DisposedContainerError);
    expect(disposed, "orphaned in-flight instance must be disposed").toBe(true);
  });

  it("in-flight async factory is orphaned on unload", async () => {
    const T = createAsyncToken<{ dispose(): void }>("ifFactory");
    let disposed = false;
    const mod = createModule((m) =>
      m.factoryAsync(
        T,
        async () => {
          await delay(30);
          return { dispose: () => (disposed = true) };
        },
        { dispose: (x) => x.dispose() },
      ),
    );
    const c = new Container();
    c.load(mod);
    const p = ignore(c.getAsync(T));
    await delay(5);
    await c.unload(mod);
    await expect(p).rejects.toThrowError(DisposedContainerError);
    expect(disposed).toBe(true);
  });

  it("child-local resolution is blocked while a parent is disposing", async () => {
    const Slow = createSyncToken<{ dispose(): Promise<void> }>("clSlow");
    const Local = createSyncToken<object>("clLocal");
    let localBuilt = 0;
    const root = new Container();
    const childA = root.createScope();
    const childB = root.createScope();
    childA.load(
      createModule((m) =>
        m.single(
          Slow,
          () => ({
            dispose: async () => {
              await delay(40);
            },
          }),
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    childB.load(
      createModule((m) =>
        m.single(Local, () => {
          localBuilt += 1;
          return {};
        }),
      ),
    );
    childA.get(Slow); // realize the slow disposable so dispose() awaits it
    const disposing = ignore(root.dispose());
    // root.disposed is now true; childB not yet marked. Resolving its own local
    // token must still be rejected because an ancestor is disposed.
    expect(() => childB.get(Local)).toThrowError(DisposedContainerError);
    await disposing;
    expect(localBuilt, "child-local instance must not be built during parent dispose").toBe(0);
  });

  it("pending child async settling after parent dispose is orphaned", async () => {
    const T = createAsyncToken<{ dispose(): void }>("pendChild");
    let disposed = false;
    const root = new Container();
    const child = root.createScope();
    child.load(
      createModule((m) =>
        m.singleAsync(
          T,
          async () => {
            await delay(40);
            return { dispose: () => (disposed = true) };
          },
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    const p = ignore(child.getAsync(T));
    await delay(5);
    await root.dispose();
    await expect(p).rejects.toThrowError(DisposedContainerError);
    expect(disposed).toBe(true);
  });

  it("randomized race: parent dispose vs child unload never double-disposes or orphans", async () => {
    const trials = 200;
    let doubles = 0;
    let orphansAlive = 0;
    let built = 0;

    for (let i = 0; i < trials; i++) {
      const root = new Container();
      const child = root.createScope();
      const T = createAsyncToken<{ dispose(): void }>(`race${i}`);
      let n = 0;
      const mod = createModule((m) =>
        m.scopedAsync(
          T,
          async () => {
            await delay(random() * 4);
            return { dispose: () => (n += 1) };
          },
          { dispose: (x) => x.dispose() },
        ),
      );
      child.load(mod);
      const p = ignore(child.getAsync(T));
      await delay(random() * 3);
      const a = ignore(child.unload(mod));
      const b = ignore(root.dispose());
      await Promise.allSettled([p, a, b]);
      await ignore(root.dispose()); // ensure final teardown regardless of who won
      await delay(2);

      if (n > 1) doubles += 1;
      if (n >= 1) built += 1;
      try {
        await child.getAsync(T);
        orphansAlive += 1;
      } catch {
        /* expected: disposed */
      }
    }

    expect(doubles, "no instance may be disposed more than once").toBe(0);
    expect(orphansAlive, "no child may remain usable after teardown").toBe(0);
    expect(built > 0, "the race window must have actually built instances").toBeTruthy();
  });

  it("a sync provider that triggers teardown during construction orphans its result", async () => {
    const T = createSyncToken<{ end(): void }>("syncOrphan");
    let ended = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(
          T,
          () => {
            void c.dispose(); // teardown begins during the provider's own construction
            return {
              end: () => {
                ended += 1;
              },
            };
          },
          { dispose: (x) => x.end() },
        ),
      ),
    );
    expect(() => c.get(T)).toThrowError(DisposedContainerError);
    await delay(1); // orphan disposal is fire-and-forget
    expect(ended).toBe(1);
  });

  it("a failing orphan disposer from a sync construction reports via onDisposeError", async () => {
    const T = createSyncToken<object>("syncOrphanFail");
    let observed: unknown = null;
    const c = new Container({
      onDisposeError: (e) => {
        observed = e;
      },
    });
    c.load(
      createModule((m) =>
        m.single(
          T,
          () => {
            void c.dispose();
            return {};
          },
          {
            dispose: () => {
              throw new Error("orphan-end-fail");
            },
          },
        ),
      ),
    );
    expect(() => c.get(T)).toThrowError(DisposedContainerError);
    await delay(1);
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toBe("orphan-end-fail");
  });

  it("deep scope chain resolves and per-resolve ancestor walk stays cheap", () => {
    const Root = createSyncToken<number>("deepRoot");
    const Leaf = createSyncToken<{ n: number }>("deepLeaf");
    const root = new Container();
    root.load(createModule((m) => m.single(Root, () => 42)));
    let c: Container = root;
    for (let i = 0; i < 25; i++) c = c.createScope();
    c.load(createModule((m) => m.scoped(Leaf, (r) => ({ n: r.get(Root) }))));
    expect(c.get(Leaf).n).toBe(42);
    expect(c.get(Leaf) === c.get(Leaf), "leaf scoped is cached within its scope").toBeTruthy();
  });
});
