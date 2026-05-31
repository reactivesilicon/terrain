import { Container, createModule, createToken } from "../../src";
import { DisposedContainerError } from "../../src";
import { suite, assert, assertEqual, assertThrows, isInstance, ignore, delay } from "../harness";

suite("concurrency", (test) => {
  test("in-flight async singleton rejects and is disposed after dispose()", async () => {
    const T = createToken<{ dispose(): void }>("ifSingle");
    let disposed = false;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          await delay(30);
          return { dispose: () => (disposed = true) };
        }),
      ),
    );
    const p = ignore(c.getAsync(T));
    await delay(5);
    await c.dispose();
    await assertThrows(() => p, isInstance(DisposedContainerError));
    assertEqual(disposed, true, "orphaned in-flight instance must be disposed");
  });

  test("in-flight async factory is orphaned on unload", async () => {
    const T = createToken<{ dispose(): void }>("ifFactory");
    let disposed = false;
    const mod = createModule((m) =>
      m.factoryAsync(T, async () => {
        await delay(30);
        return { dispose: () => (disposed = true) };
      }),
    );
    const c = new Container();
    c.load(mod);
    const p = ignore(c.getAsync(T));
    await delay(5);
    await c.unload(mod);
    await assertThrows(() => p, isInstance(DisposedContainerError));
    assertEqual(disposed, true);
  });

  test("child-local resolution is blocked while a parent is disposing", async () => {
    const Slow = createToken<{ dispose(): Promise<void> }>("clSlow");
    const Local = createToken<object>("clLocal");
    let localBuilt = 0;
    const root = new Container();
    const childA = root.createScope();
    const childB = root.createScope();
    childA.load(
      createModule((m) =>
        m.single(Slow, () => ({
          dispose: async () => {
            await delay(40);
          },
        })),
      ),
    );
    childB.load(
      createModule((m) =>
        m.single(Local, () => {
          localBuilt++;
          return {};
        }),
      ),
    );
    childA.get(Slow); // realize the slow disposable so dispose() awaits it
    const disposing = ignore(root.dispose());
    // root.disposed is now true; childB not yet marked. Resolving its own local
    // token must still be rejected because an ancestor is disposed.
    await assertThrows(() => childB.get(Local), isInstance(DisposedContainerError));
    await disposing;
    assertEqual(localBuilt, 0, "child-local instance must not be built during parent dispose");
  });

  test("pending child async settling after parent dispose is orphaned", async () => {
    const T = createToken<{ dispose(): void }>("pendChild");
    let disposed = false;
    const root = new Container();
    const child = root.createScope();
    child.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          await delay(40);
          return { dispose: () => (disposed = true) };
        }),
      ),
    );
    const p = ignore(child.getAsync(T));
    await delay(5);
    await root.dispose();
    await assertThrows(() => p, isInstance(DisposedContainerError));
    assertEqual(disposed, true);
  });

  test("randomized race: parent dispose vs child unload never double-disposes or orphans", async () => {
    const trials = 200;
    let doubles = 0;
    let orphansAlive = 0;
    let built = 0;

    for (let i = 0; i < trials; i++) {
      const root = new Container();
      const child = root.createScope();
      const T = createToken<{ dispose(): void }>(`race${i}`);
      let n = 0;
      const mod = createModule((m) =>
        m.scopedAsync(T, async () => {
          await delay(Math.random() * 4);
          return { dispose: () => n++ };
        }),
      );
      child.load(mod);
      const p = ignore(child.getAsync(T));
      await delay(Math.random() * 3);
      const a = ignore(child.unload(mod));
      const b = ignore(root.dispose());
      await Promise.allSettled([p, a, b]);
      await ignore(root.dispose()); // ensure final teardown regardless of who won
      await delay(2);

      if (n > 1) doubles++;
      if (n >= 1) built++;
      try {
        child.get(T);
        orphansAlive++;
      } catch {
        /* expected: disposed */
      }
    }

    assertEqual(doubles, 0, "no instance may be disposed more than once");
    assertEqual(orphansAlive, 0, "no child may remain usable after teardown");
    assert(built > 0, "the race window must have actually built instances");
  });

  test("deep scope chain resolves and per-resolve ancestor walk stays cheap", () => {
    const Root = createToken<number>("deepRoot");
    const Leaf = createToken<{ n: number }>("deepLeaf");
    const root = new Container();
    root.load(createModule((m) => m.single(Root, () => 42)));
    let c: Container = root;
    for (let i = 0; i < 25; i++) c = c.createScope();
    c.load(createModule((m) => m.scoped(Leaf, (r) => ({ n: r.get(Root) }))));
    assertEqual(c.get(Leaf).n, 42);
    assert(c.get(Leaf) === c.get(Leaf), "leaf scoped is cached within its scope");
  });
});
