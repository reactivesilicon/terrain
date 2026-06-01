import { Container, createModule, createToken } from "../../src";
import {
  DefinitionInUseError,
  DisposedContainerError,
  DuplicateDefinitionError,
  LifecycleOperationError,
  ModuleOwnershipError,
} from "../../src";
import { suite, assert, assertEqual, assertThrows, isInstance, ignore, delay } from "../harness";

suite("lifecycle: load", (test) => {
  test("duplicate definition is rejected without override", async () => {
    const T = createToken<number>("dup");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    await assertThrows(() => c.load(createModule((m) => m.single(T, () => 2))), isInstance(DuplicateDefinitionError));
  });

  test("load is transactional: a failing entry applies nothing", async () => {
    const A = createToken<number>("txA");
    const B = createToken<number>("txB");
    const c = new Container();
    c.load(createModule((m) => m.single(B, () => 99))); // B already present
    await assertThrows(
      () =>
        c.load(
          createModule((m) => {
            m.single(A, () => 1);
            m.single(B, () => 2); // duplicate -> whole load must abort
          }),
        ),
      isInstance(DuplicateDefinitionError),
    );
    assertEqual(c.has(A), false, "A must not have been partially registered");
    assertEqual(c.get(B), 99, "existing B must be untouched");
  });

  test("override before use replaces the definition", () => {
    const T = createToken<number>("ovOk");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    c.load(
      createModule((m) => m.single(T, () => 2)),
      { override: true },
    );
    assertEqual(c.get(T), 2);
  });

  test("override of an in-use token is rejected", async () => {
    const T = createToken<number>("ovUsed");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    c.get(T);
    await assertThrows(
      () =>
        c.load(
          createModule((m) => m.single(T, () => 2)),
          { override: true },
        ),
      isInstance(DefinitionInUseError),
    );
  });

  test("override blocked by an in-flight async factory", async () => {
    const T = createToken<number>("ovFactory");
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
    await assertThrows(
      () =>
        c.load(
          createModule((m) => m.factoryAsync(T, async () => 2)),
          { override: true },
        ),
      isInstance(DefinitionInUseError),
    );
    await p;
  });
});

suite("lifecycle: unload", (test) => {
  test("unload removes definitions and disposes instances", async () => {
    const T = createToken<{ dispose(): void }>("ul");
    let disposed = 0;
    const mod = createModule((m) => m.single(T, () => ({ dispose: () => (disposed += 1) })));
    const c = new Container();
    c.load(mod);
    c.get(T);
    await c.unload(mod);
    assertEqual(disposed, 1);
    assertEqual(c.has(T), false);
  });

  test("unload rejects a module not owned by the container", async () => {
    const T = createToken<number>("ulOwn");
    const mod = createModule((m) => m.single(T, () => 1));
    const root = new Container();
    root.load(mod);
    const scope = root.createScope();
    await assertThrows(() => scope.unload(mod), isInstance(ModuleOwnershipError));
  });

  test("unload disposes a scoped instance cached in a child scope", async () => {
    const T = createToken<{ dispose(): void }>("ulChild");
    let disposed = 0;
    const mod = createModule((m) => m.scoped(T, () => ({ dispose: () => (disposed += 1) })));
    const root = new Container();
    root.load(mod);
    const scope = root.createScope();
    scope.get(T);
    await root.unload(mod);
    assertEqual(disposed, 1);
  });

  test("unload disposes in reverse creation order", async () => {
    const Db = createToken<{ dispose(): void }>("ulDb");
    const Repo = createToken<{ dispose(): void }>("ulRepo");
    const order: string[] = [];
    const mod = createModule((m) => {
      m.single(Db, () => ({ dispose: () => order.push("db") }));
      m.single(Repo, (r) => {
        r.get(Db);
        return { dispose: () => order.push("repo") };
      });
    });
    const c = new Container();
    c.load(mod);
    c.get(Repo);
    await c.unload(mod);
    assertEqual(order.join(","), "repo,db");
  });

  test("unload surfaces disposal failures via AggregateError but still cleans up", async () => {
    const T = createToken<{ dispose(): void }>("ulFail");
    const mod = createModule((m) =>
      m.single(T, () => ({
        dispose: () => {
          throw new Error("boom");
        },
      })),
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
    assert(threw, "expected AggregateError");
    assertEqual(c.has(T), false, "definition must still be removed");
  });

  test("a token mid-unload cannot be re-resolved by an in-flight provider", async () => {
    // A (in module modA) depends on B (in module modB). While A's async provider
    // is parked, we unload ONLY modB. A then resumes and tries to resolve B; the
    // unload gate must make that fail rather than rebuild/re-cache B. A itself is
    // not being unloaded, so its provider runs to completion.
    const A = createToken<{ b: { tag: string } | null }>("ulA");
    const B = createToken<{ tag: string }>("ulB");
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
    assert(bResolveError !== null, "A's resolution of B during unload must have failed");
    assertEqual(a.b, null);
    assertEqual(bBuilds, buildsAfterPrime, "B must not be rebuilt during unload");
  });
});

suite("lifecycle: tree-wide locking", (test) => {
  test("concurrent load during in-progress unload is rejected", async () => {
    const T = createToken<number>("lkT");
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
    await assertThrows(
      () => c.load(createModule((m) => m.single(createToken<number>("lkOther"), () => 2))),
      isInstance(LifecycleOperationError),
    );
    await u;
  });

  test("child load is blocked while a root unload runs (tree-wide)", async () => {
    const T = createToken<number>("lkRoot");
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
    await assertThrows(
      () => child.load(createModule((m) => m.single(createToken<number>("lkChild"), () => 2))),
      isInstance(LifecycleOperationError),
    );
    await u;
  });

  test("dispose during an in-progress unload is rejected", async () => {
    const T = createToken<number>("lkDisp");
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
    await assertThrows(() => c.dispose(), isInstance(LifecycleOperationError));
    await u;
  });

  test("ownership: a parent disposing while a child unloads does not orphan the child", async () => {
    const CT = createToken<{ dispose(): void }>("ownChild");
    const cm = createModule((m) =>
      m.singleAsync(CT, async () => {
        await delay(30);
        return { dispose: () => {} };
      }),
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
    assertEqual(outcome, "rejected");
    // Once the unload finishes, the tree can be disposed cleanly.
    await root.dispose();
    await assertThrows(
      () => child.get(CT),
      (e) => e instanceof DisposedContainerError || e instanceof Error,
    );
  });
});
