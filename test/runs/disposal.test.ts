import { describe, expect, it } from "vitest";

import { Container, createModule, createAsyncToken, createSyncToken } from "../../src";
import { DisposedContainerError } from "../../src";
import { delay } from "../helpers";

describe("disposal", () => {
  it("disposes in reverse creation order", async () => {
    const Db = createSyncToken<{ dispose(): void }>("db");
    const Repo = createSyncToken<{ dispose(): void }>("repo");
    const order: string[] = [];
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(Db, () => ({ dispose: () => order.push("db") }), { dispose: (x) => x.dispose() });
        m.single(
          Repo,
          (r) => {
            r.get(Db);
            return { dispose: () => order.push("repo") };
          },
          { dispose: (x) => x.dispose() },
        );
      }),
    );
    c.get(Repo);
    await c.dispose();
    expect(order.join(",")).toBe("repo,db");
  });

  it("singleton disposable is disposed", async () => {
    const T = createSyncToken<{ dispose(): void }>("singleDisp");
    let n = 0;
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => ({ dispose: () => (n += 1) }), { dispose: (x) => x.dispose() })));
    c.get(T);
    await c.dispose();
    expect(n).toBe(1);
  });

  it("factory instances are not auto-tracked for disposal", async () => {
    const T = createSyncToken<{ dispose(): void }>("factoryDisp");
    let n = 0;
    const c = new Container();
    c.load(createModule((m) => m.factory(T, () => ({ dispose: () => (n += 1) }), { dispose: (x) => x.dispose() })));
    for (let i = 0; i < 500; i++) c.get(T);
    await c.dispose();
    expect(n, "factories are caller-owned").toBe(0);
  });

  it("dispose is idempotent", async () => {
    const T = createSyncToken<{ dispose(): void }>("idem");
    let n = 0;
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => ({ dispose: () => (n += 1) }), { dispose: (x) => x.dispose() })));
    c.get(T);
    await c.dispose();
    await c.dispose();
    await c.dispose();
    expect(n).toBe(1);
  });

  it("concurrent dispose calls do not double-dispose or throw", async () => {
    const T = createAsyncToken<{ dispose(): void }>("concDisp");
    let n = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(
          T,
          async () => {
            await delay(10);
            return { dispose: () => (n += 1) };
          },
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    await c.getAsync(T);
    const results = await Promise.allSettled([c.dispose(), c.dispose()]);
    expect(!results.some((r) => r.status === "rejected"), "neither dispose should reject").toBeTruthy();
    expect(n).toBe(1);
  });

  it("disposing root cascades to child scopes", async () => {
    const T = createSyncToken<{ dispose(): void }>("cascade");
    let n = 0;
    const root = new Container();
    root.load(createModule((m) => m.scoped(T, () => ({ dispose: () => (n += 1) }), { dispose: (x) => x.dispose() })));
    const scope = root.createScope();
    scope.get(T);
    await root.dispose();
    expect(n).toBe(1);
  });

  it("a child scope disposer failure surfaces in the root dispose AggregateError", async () => {
    const T = createSyncToken<object>("childBoom");
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(T, () => ({}), {
          dispose: () => {
            throw new Error("child-boom");
          },
        }),
      ),
    );
    root.createScope().get(T);
    const failure = await root.dispose().then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.some((e) => e instanceof Error && e.message === "child-boom")).toBe(true);
  });

  it("a disposed container rejects further resolution", async () => {
    const T = createSyncToken<number>("postDispose");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    await c.dispose();
    expect(() => c.get(T)).toThrowError(DisposedContainerError);
    expect(() => c.has(T)).toThrowError(DisposedContainerError);
    expect(() => c.inject(T)).toThrowError(DisposedContainerError);
  });

  it("onDisposeError observes orphan disposal failure without altering rejection", async () => {
    const T = createAsyncToken<{ dispose(): void }>("orphanHook");
    let hookError: unknown = null;
    const c = new Container({
      onDisposeError: (e) => {
        hookError = e;
      },
    });
    c.load(
      createModule((m) =>
        m.singleAsync(
          T,
          async () => {
            await delay(30);
            return {
              dispose: () => {
                throw new Error("orphan-dispose");
              },
            };
          },
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    const p = c.getAsync(T);
    let rejection: unknown;
    p.catch((e) => {
      rejection = e;
    });
    await delay(5);
    await c.dispose();
    await delay(10);
    expect(rejection instanceof DisposedContainerError, "caller sees DisposedContainerError").toBeTruthy();
    expect(
      hookError instanceof Error && hookError.message === "orphan-dispose",
      "hook observes the disposal failure",
    ).toBeTruthy();
  });

  it("a throwing onDisposeError does not change the rejection type", async () => {
    const T = createAsyncToken<{ dispose(): void }>("hookThrows");
    const c = new Container({
      onDisposeError: () => {
        throw new Error("hook boom");
      },
    });
    c.load(
      createModule((m) =>
        m.singleAsync(
          T,
          async () => {
            await delay(30);
            return {
              dispose: () => {
                throw new Error("disp");
              },
            };
          },
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    const p = c.getAsync(T);
    let rejection: unknown;
    p.catch((e) => {
      rejection = e;
    });
    await delay(5);
    await c.dispose();
    await delay(10);
    expect(rejection instanceof DisposedContainerError).toBeTruthy();
  });

  it("dispose collects disposal errors into an AggregateError", async () => {
    const T = createSyncToken<{ dispose(): void }>("disposeThrows");
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(
          T,
          () => ({
            dispose: () => {
              throw new Error("boom");
            },
          }),
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    c.get(T);
    let caught: unknown;
    try {
      await c.dispose();
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof AggregateError, "dispose must reject with AggregateError").toBeTruthy();
    expect(
      (caught as AggregateError).errors.some((x) => x instanceof Error && x.message === "boom"),
      "original disposal error must be present",
    ).toBeTruthy();
  });

  it("disposes a 3-chain in reverse creation order", async () => {
    const A = createSyncToken<{ dispose(): void }>("a3");
    const B = createSyncToken<{ dispose(): void }>("b3");
    const D = createSyncToken<{ dispose(): void }>("c3");
    const order: string[] = [];
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, () => ({ dispose: () => order.push("a") }), { dispose: (x) => x.dispose() });
        m.single(
          B,
          (r) => {
            r.get(A);
            return { dispose: () => order.push("b") };
          },
          { dispose: (x) => x.dispose() },
        );
        m.single(
          D,
          (r) => {
            r.get(B);
            return { dispose: () => order.push("c") };
          },
          { dispose: (x) => x.dispose() },
        );
      }),
    );
    c.get(D); // creation order a, b, c
    await c.dispose();
    expect(order.join(",")).toBe("c,b,a");
  });

  it("one throwing disposal does not prevent the others", async () => {
    const A = createSyncToken<{ dispose(): void }>("aFail");
    const B = createSyncToken<{ dispose(): void }>("bFail");
    const D = createSyncToken<{ dispose(): void }>("cFail");
    const disposed: string[] = [];
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, () => ({ dispose: () => disposed.push("a") }), { dispose: (x) => x.dispose() });
        m.single(
          B,
          (r) => {
            r.get(A);
            return {
              dispose: () => {
                throw new Error("middle");
              },
            };
          },
          { dispose: (x) => x.dispose() },
        );
        m.single(
          D,
          (r) => {
            r.get(B);
            return { dispose: () => disposed.push("c") };
          },
          { dispose: (x) => x.dispose() },
        );
      }),
    );
    c.get(D);
    let caught: unknown;
    try {
      await c.dispose();
    } catch (e) {
      caught = e;
    }
    expect(disposed.sort().join(","), "non-throwing disposables still disposed").toBe("a,c");
    expect(
      caught instanceof AggregateError && caught.errors.some((x) => x instanceof Error && x.message === "middle"),
      "the failure is surfaced",
    ).toBeTruthy();
  });

  it("mixed singleton and scoped disposables dispose in reverse creation order", async () => {
    const Single = createSyncToken<{ dispose(): void }>("mixSingle");
    const Scoped = createSyncToken<{ dispose(): void }>("mixScoped");
    const order: string[] = [];
    const root = new Container();
    root.load(
      createModule((m) => {
        m.single(Single, () => ({ dispose: () => order.push("single") }), { dispose: (x) => x.dispose() });
        m.scoped(
          Scoped,
          (r) => {
            r.get(Single); // single created first
            return { dispose: () => order.push("scoped") };
          },
          { dispose: (x) => x.dispose() },
        );
      }),
    );
    const scope = root.createScope();
    scope.get(Scoped);
    await scope.dispose();
    // scope disposes its own scoped instance; single lives on root, untouched here
    expect(order.join(",")).toBe("scoped");
    await root.dispose();
    expect(order.join(",")).toBe("scoped,single");
  });

  it("an instance with a dispose() method but no registered disposer is left alone", async () => {
    const T = createSyncToken<{ dispose(): void }>("noDuckTyping");
    let n = 0;
    const c = new Container();
    // No { dispose } option: the container must not call the method on its own.
    c.load(createModule((m) => m.single(T, () => ({ dispose: () => (n += 1) }))));
    c.get(T);
    await c.dispose();
    expect(n, "dispose() duck-typing must not exist").toBe(0);
  });

  it("disposer works for teardown methods not named dispose()", async () => {
    const T = createSyncToken<{ end(): Promise<void> }>("closeNamed");
    let ended = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(
          T,
          () => ({
            end: async () => {
              ended += 1;
            },
          }),
          { dispose: (pool) => pool.end() },
        ),
      ),
    );
    c.get(T);
    await c.dispose();
    expect(ended, "registered disposer must run, regardless of method name").toBe(1);
  });

  it("unloading an alias never runs the owner's disposer (token-keyed disposal)", async () => {
    const Owner = createSyncToken<{ end(): void }>("aliasOwner");
    const Alias = createSyncToken<{ end(): void }>("aliasView");
    let ownerEnded = 0;
    let aliasCleanup = 0;
    const ownerMod = createModule((m) =>
      m.single(Owner, () => ({ end: () => (ownerEnded += 1) }), { dispose: (x) => x.end() }),
    );
    const aliasMod = createModule((m) =>
      // Alias: provider returns the owner's instance. Its disposer must run on
      // its own teardown without destroying the shared resource.
      m.single(Alias, (r) => r.get(Owner), {
        dispose: () => {
          aliasCleanup += 1;
        },
      }),
    );
    const c = new Container();
    c.load(ownerMod);
    c.load(aliasMod);
    expect(c.get(Alias) === c.get(Owner), "alias and owner share one instance").toBeTruthy();
    await c.unload(aliasMod);
    expect(aliasCleanup, "the alias's own disposer runs on its unload").toBe(1);
    expect(ownerEnded, "the owner's disposer must not run when only the alias is unloaded").toBe(0);
    expect(c.get(Owner).end !== undefined, "owner stays resolvable").toBe(true);
    await c.dispose();
    expect(ownerEnded, "owner's disposer runs once at container dispose").toBe(1);
  });

  it("unload disposes evicted instances in reverse creation order", async () => {
    const A = createSyncToken<{ dispose(): void }>("ulA");
    const B = createSyncToken<{ dispose(): void }>("ulB");
    const order: string[] = [];
    const mod = createModule((m) => {
      m.single(A, () => ({ dispose: () => order.push("a") }), { dispose: (x) => x.dispose() });
      m.single(
        B,
        (r) => {
          r.get(A);
          return { dispose: () => order.push("b") };
        },
        { dispose: (x) => x.dispose() },
      );
    });
    const c = new Container();
    c.load(mod);
    c.get(B); // creation order a, b
    await c.unload(mod);
    expect(order.join(",")).toBe("b,a");
  });
});
