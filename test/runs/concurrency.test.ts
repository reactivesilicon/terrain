import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DisposedContainerError, LifecycleOperationError } from "../../src";
import { createGate, delay, ignore, random } from "../helpers";
import { CircularDependencyError, Container, createModule, createAsyncToken, createSyncToken } from "../internal-api";

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

  it("in-flight async factory is orphaned on dispose", async () => {
    const T = createAsyncToken<object>("ifFactoryDispose");
    const providerGate = createGate();
    let disposed = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.factoryAsync(
          T,
          async () => {
            await providerGate.opened;
            return {};
          },
          { dispose: () => void (disposed += 1) },
        ),
      ),
    );
    const orphaned = ignore(c.getAsync(T));
    const disposal = c.dispose();
    providerGate.open();

    await expect(orphaned).rejects.toThrowError(DisposedContainerError);
    await disposal;
    expect(disposed).toBe(1);
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

  it("an orphaned async instance without a disposer is dropped quietly", async () => {
    const T = createAsyncToken<object>("orphanNoDisposer");
    const providerGate = createGate();
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = new Container();
      c.load(
        createModule((m) =>
          m.singleAsync(T, async () => {
            await providerGate.opened;
            return {};
          }),
        ),
      );
      const orphaned = ignore(c.getAsync(T));
      const disposal = c.dispose();
      providerGate.open();

      await expect(orphaned).rejects.toThrowError(DisposedContainerError);
      await disposal;
      expect(printed).not.toHaveBeenCalled();
    } finally {
      printed.mockRestore();
    }
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

describe("concurrency: disposal coordination", () => {
  it("sibling callback scopes dispose concurrently", async () => {
    const Conn = createSyncToken<object>("sibConn");
    const disposerGate = createGate();
    let disposeCount = 0;
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(Conn, () => ({}), {
          dispose: async () => {
            await disposerGate.opened;
            disposeCount += 1;
          },
        }),
      ),
    );

    const scopeResults = Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        root.withScope((scope) => {
          scope.get(Conn);
          return i;
        }),
      ),
    );
    await delay(0);
    disposerGate.open();

    expect(await scopeResults).toEqual([0, 1, 2, 3, 4].map((value) => ({ status: "fulfilled", value })));
    expect(disposeCount).toBe(5);
  });

  it("every dispose() call settles only after teardown has finished", async () => {
    const Pool = createSyncToken<object>("joinPool");
    const disposerGate = createGate();
    const events: string[] = [];
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(Pool, () => ({}), {
          dispose: async () => {
            await disposerGate.opened;
            events.push("pool disposed");
          },
        }),
      ),
    );
    c.get(Pool);

    const first = c.dispose().then(() => events.push("first settled"));
    const second = c.dispose().then(() => events.push("second settled"));
    await delay(0);
    expect(events, "no dispose() may settle while a disposer is still running").toEqual([]);

    disposerGate.open();
    await Promise.all([first, second]);
    expect(events).toEqual(["pool disposed", "first settled", "second settled"]);
  });

  it("root dispose joins a child's in-progress disposal: dependents finish before dependencies", async () => {
    const Pool = createSyncToken<object>("orderPool");
    const Tx = createSyncToken<object>("orderTx");
    const txDisposerGate = createGate();
    const events: string[] = [];
    const root = new Container();
    root.load(
      createModule((m) => {
        m.single(Pool, () => ({}), { dispose: () => void events.push("pool disposed") });
        m.scoped(Tx, (r) => (r.get(Pool), {}), {
          dispose: async () => {
            await txDisposerGate.opened;
            events.push("tx disposed");
          },
        });
      }),
    );
    const scope = root.createScope();
    scope.get(Tx);

    const scopeDisposal = scope.dispose();
    await delay(0);
    const rootDisposal = root.dispose();
    await delay(0);
    expect(events, "the root must wait for the child's disposal before its own").toEqual([]);

    txDisposerGate.open();
    await Promise.all([scopeDisposal, rootDisposal]);
    expect(events).toEqual(["tx disposed", "pool disposed"]);
  });

  it("a callback scope finishing while its root is mid-dispose still returns its body result", async () => {
    const Conn = createSyncToken<object>("midConn");
    const firstScopeDisposerGate = createGate();
    const bodyGate = createGate();
    let disposeCount = 0;
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(Conn, () => ({}), {
          dispose: async () => {
            disposeCount += 1;
            if (disposeCount === 1) await firstScopeDisposerGate.opened;
          },
        }),
      ),
    );
    const scopeHoldingUpTheCascade = root.createScope();
    scopeHoldingUpTheCascade.get(Conn);
    const lateScope = root.withScope(async (scope) => {
      scope.get(Conn);
      await bodyGate.opened;
      return "late body result";
    });

    const rootDisposal = root.dispose();
    await delay(0);
    bodyGate.open(); // the cascade has not reached this scope yet
    await delay(0);
    firstScopeDisposerGate.open();

    await expect(lateScope).resolves.toBe("late body result");
    await rootDisposal;
    expect(disposeCount).toBe(2);
  });

  it("a failing disposal is reported only to its starter: an ancestor that joined it resolves", async () => {
    const Tx = createSyncToken<object>("failTx");
    const disposerGate = createGate();
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(Tx, () => ({}), {
          dispose: async () => {
            await disposerGate.opened;
            throw new Error("tx-boom");
          },
        }),
      ),
    );
    const scope = root.createScope();
    scope.get(Tx);

    const scopeDisposal = scope.dispose().then(
      () => null,
      (e: unknown) => e,
    );
    await delay(0);
    const rootDisposal = root.dispose();
    disposerGate.open();

    const scopeFailure = await scopeDisposal;
    expect(scopeFailure).toBeInstanceOf(AggregateError);
    expect((scopeFailure as AggregateError).errors.map((e) => (e as Error).message)).toEqual(["tx-boom"]);
    await expect(rootDisposal).resolves.toBeUndefined();
  });

  it("a failure in a scope disposal the root's cascade started goes to the root, not the callback scope", async () => {
    const Tx = createSyncToken<object>("cascadeFailTx");
    const bodyGate = createGate();
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(Tx, () => ({}), {
          dispose: () => {
            throw new Error("tx-boom");
          },
        }),
      ),
    );
    const request = root.withScope(async (scope) => {
      scope.get(Tx);
      await bodyGate.opened;
      return "body result";
    });

    const shutdown = root.dispose().then(
      () => null,
      (e: unknown) => e,
    );
    await delay(0); // the cascade has started this scope's disposal
    bodyGate.open();

    await expect(request).resolves.toBe("body result");
    const shutdownFailure = await shutdown;
    expect(shutdownFailure).toBeInstanceOf(AggregateError);
    expect((shutdownFailure as AggregateError).errors.map((e) => (e as Error).message)).toEqual(["tx-boom"]);
  });

  it("dispose() after a failed dispose() resolves", async () => {
    const T = createSyncToken<object>("failedTwice");
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(T, () => ({}), {
          dispose: () => {
            throw new Error("boom");
          },
        }),
      ),
    );
    c.get(T);

    await expect(c.dispose()).rejects.toBeInstanceOf(AggregateError);
    await expect(c.dispose()).resolves.toBeUndefined();
  });

  it.each([
    ["before", false],
    ["after an await", true],
  ])("a disposer awaiting its own container's dispose() %s returns at once", async (_, awaitsFirst) => {
    const T = createSyncToken<object>(`selfAwait-${awaitsFirst}`);
    let disposerFinished = false;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(T, () => ({}), {
          dispose: async () => {
            if (awaitsFirst) await Promise.resolve();
            await c.dispose();
            disposerFinished = true;
          },
        }),
      ),
    );
    c.get(T);

    await c.dispose();
    expect(disposerFinished).toBe(true);
  });

  it("a disposer awaiting its own scope's dispose() returns at once", async () => {
    const Tx = createSyncToken<object>("selfScopeAwait");
    const root = new Container();
    const scope = root.createScope();
    root.load(
      createModule((m) =>
        m.scoped(Tx, () => ({}), {
          dispose: async () => {
            await Promise.resolve();
            await scope.dispose();
          },
        }),
      ),
    );
    scope.get(Tx);

    await scope.dispose();
    await root.dispose();
  });

  it("a scoped disposer awaiting an already-disposing ancestor's dispose() returns at once", async () => {
    const Tx = createSyncToken<object>("ancestorAwait");
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(Tx, () => ({}), {
          dispose: async () => {
            await Promise.resolve();
            await root.dispose();
          },
        }),
      ),
    );
    root.createScope().get(Tx);

    await root.dispose();
  });

  it("a scoped disposer starting its ancestor's disposal returns at once; the ancestor then finishes", async () => {
    const Pool = createSyncToken<object>("ancestorStartPool");
    const Tx = createSyncToken<object>("ancestorStartTx");
    const events: string[] = [];
    const root = new Container();
    root.load(
      createModule((m) => {
        m.single(Pool, () => ({}), { dispose: () => void events.push("pool disposed") });
        m.scoped(Tx, () => ({}), {
          dispose: async () => {
            await Promise.resolve();
            await root.dispose();
            events.push("tx disposed");
          },
        });
      }),
    );
    root.get(Pool);

    await root.withScope((scope) => void scope.get(Tx));
    expect(root.isTreeDisposed(), "the disposer's call started the root's disposal").toBe(true);
    await root.dispose(); // an outside caller joins it and waits for it to finish
    expect(events).toEqual(["tx disposed", "pool disposed"]);
  });

  it("a failure of a disposal started from inside a disposer goes to onDisposeError", async () => {
    const Pool = createSyncToken<object>("reportedPool");
    const Tx = createSyncToken<object>("reportedTx");
    const reported: unknown[] = [];
    const root = new Container({ onDisposeError: (error) => reported.push(error) });
    root.load(
      createModule((m) => {
        m.single(Pool, () => ({}), {
          dispose: () => {
            throw new Error("pool-boom");
          },
        });
        m.scoped(Tx, () => ({}), { dispose: () => root.dispose() });
      }),
    );
    root.get(Pool);

    await root.withScope((scope) => void scope.get(Tx));
    await root.dispose();
    expect(reported).toHaveLength(1);
    expect((reported[0] as AggregateError).errors.map((e) => (e as Error).message)).toEqual(["pool-boom"]);
  });

  it.each([
    [
      "an event listener it fires",
      (root: Container) => {
        const closeEvents = new EventEmitter();
        let listenerDisposal: Promise<void> = Promise.resolve();
        closeEvents.on("closed", () => (listenerDisposal = root.dispose()));
        return async () => {
          await Promise.resolve();
          closeEvents.emit("closed");
          await listenerDisposal;
        };
      },
    ],
    [
      "a callback it defers",
      (root: Container) => () => new Promise<void>((resolve) => setTimeout(() => resolve(root.dispose()), 0)),
    ],
  ])("a disposer's call is recognized through %s", async (_, makeDisposer) => {
    const Tx = createSyncToken<object>(`recognized-${String(_)}`);
    const root = new Container();
    root.load(createModule((m) => m.scoped(Tx, () => ({}), { dispose: makeDisposer(root) })));

    await root.withScope((scope) => void scope.get(Tx));
    await root.dispose();
  });

  it("an outside caller arriving while a disposer runs still waits for teardown", async () => {
    const T = createSyncToken<object>("outsideWaits");
    const disposerGate = createGate();
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => ({}), { dispose: () => disposerGate.opened })));
    c.get(T);

    const first = c.dispose();
    await delay(0); // the disposer is now running
    let outsideSettled = false;
    const outside = c.dispose().then(() => (outsideSettled = true));
    await delay(0);
    expect(outsideSettled).toBe(false);

    disposerGate.open();
    await Promise.all([first, outside]);
    expect(outsideSettled).toBe(true);
  });

  it("a call from code a finished disposer left behind waits for teardown like any outside call", async () => {
    const Db = createSyncToken<object>("leftBehindDb");
    const Req = createSyncToken<object>("leftBehindReq");
    const dbDisposerGate = createGate();
    const events: string[] = [];
    let leftBehindCall: Promise<void> = Promise.resolve();
    const root = new Container();
    root.load(
      createModule((m) => {
        m.single(Db, () => ({}), {
          dispose: async () => {
            await dbDisposerGate.opened;
            events.push("db closed");
          },
        });
        m.scoped(Req, () => ({}), {
          dispose: () => {
            setTimeout(() => {
              leftBehindCall = root.dispose().then(() => void events.push("left-behind dispose() returned"));
            }, 0);
          },
        });
      }),
    );
    root.get(Db);

    await root.withScope((scope) => void scope.get(Req)); // the scoped disposer has finished
    await delay(5); // its timer has fired and called root.dispose()
    dbDisposerGate.open();
    await leftBehindCall;
    expect(events).toEqual(["db closed", "left-behind dispose() returned"]);
  });

  it("a non-native thenable a disposer returns is still awaited by teardown", async () => {
    const Pool = createSyncToken<object>("thenablePool");
    const Tx = createSyncToken<object>("thenableTx");
    const events: string[] = [];
    const c = new Container();
    const closingThenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- this test is about a non-native thenable
      then(onFulfilled: () => void) {
        setTimeout(() => {
          events.push("tx closed");
          onFulfilled();
        }, 5);
      },
    } as unknown as Promise<void>;
    c.load(
      createModule((m) => {
        m.single(Pool, () => ({}), { dispose: () => void events.push("pool closed") });
        m.scoped(Tx, (r) => (r.get(Pool), {}), { dispose: () => closingThenable });
      }),
    );
    c.get(Tx);

    await c.dispose();
    expect(events).toEqual(["tx closed", "pool closed"]);
  });

  it("a disposer returning a plain non-promise value is treated as finished at once", async () => {
    const T = createSyncToken<{ close(): object }>("plainReturn");
    let closed = 0;
    const c = new Container();
    const closeReturningSelf = (pool: { close(): object }) => pool.close() as unknown as void; // e.g. a JS close() returning `this`
    c.load(
      createModule((m) =>
        m.single(
          T,
          () => ({
            close() {
              closed += 1;
              return this;
            },
          }),
          { dispose: closeReturningSelf },
        ),
      ),
    );
    c.get(T);

    await c.dispose();
    expect(closed).toBe(1);
  });

  describe("failures no caller can receive", () => {
    const loadGatedSingletonWithFailingDisposer = (
      c: Container,
      token: ReturnType<typeof createAsyncToken<object>>,
    ) => {
      const providerGate = createGate();
      c.load(
        createModule((m) =>
          m.singleAsync(
            token,
            async () => {
              await providerGate.opened;
              return {};
            },
            {
              dispose: () => {
                throw new Error("orphan-boom");
              },
            },
          ),
        ),
      );
      return providerGate;
    };

    it("are printed with console.error when no onDisposeError hook is set", async () => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const Orphan = createAsyncToken<object>("printedOrphan");
        const c = new Container();
        const providerGate = loadGatedSingletonWithFailingDisposer(c, Orphan);
        const orphaned = ignore(c.getAsync(Orphan));
        const disposal = c.dispose();
        providerGate.open();
        await orphaned.catch(() => {});
        await disposal;

        expect(printed).toHaveBeenCalledTimes(1);
        expect((printed.mock.calls[0]![0] as Error).message).toBe("orphan-boom");
      } finally {
        printed.mockRestore();
      }
    });

    it("go only to the onDisposeError hook when one is set", async () => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const Orphan = createAsyncToken<object>("hookedOrphan");
        const reported: unknown[] = [];
        const c = new Container({ onDisposeError: (error) => reported.push(error) });
        const providerGate = loadGatedSingletonWithFailingDisposer(c, Orphan);
        const orphaned = ignore(c.getAsync(Orphan));
        const disposal = c.dispose();
        providerGate.open();
        await orphaned.catch(() => {});
        await disposal;

        expect(reported.map((e) => (e as Error).message)).toEqual(["orphan-boom"]);
        expect(printed).not.toHaveBeenCalled();
      } finally {
        printed.mockRestore();
      }
    });
  });

  it.each([
    ["starts", false],
    ["joins", true],
  ])(
    "scope disposers awaiting each other's dispose() don't deadlock when one %s the other's disposal",
    async (_, siblingAlreadyDisposing) => {
      const A = createSyncToken<object>(`mutualA-${siblingAlreadyDisposing}`);
      const B = createSyncToken<object>(`mutualB-${siblingAlreadyDisposing}`);
      const bDisposerGate = createGate();
      const root = new Container();
      const scopeA = root.createScope();
      const scopeB = root.createScope();
      root.load(
        createModule((m) => {
          m.scoped(A, () => ({}), {
            dispose: async () => {
              await Promise.resolve();
              await scopeB.dispose();
            },
          });
          m.scoped(B, () => ({}), {
            dispose: async () => {
              await bDisposerGate.opened;
              await scopeA.dispose();
            },
          });
        }),
      );
      scopeA.get(A);
      scopeB.get(B);

      const scopeBDisposal = siblingAlreadyDisposing ? scopeB.dispose() : Promise.resolve();
      const scopeADisposal = scopeA.dispose();
      await delay(0); // A's disposer is now waiting on B's disposal
      bDisposerGate.open();

      await Promise.all([scopeADisposal, scopeBDisposal]);
      await root.dispose();
    },
  );

  it("a three-way cycle of scope disposers awaiting each other's dispose() doesn't deadlock", async () => {
    const tokens = [0, 1, 2].map((i) => createSyncToken<object>(`threeWay${i}`));
    const root = new Container();
    const scopes = tokens.map(() => root.createScope());
    root.load(
      createModule((m) =>
        tokens.forEach((token, i) =>
          m.scoped(token, () => ({}), {
            dispose: async () => {
              await Promise.resolve();
              await scopes[(i + 1) % scopes.length]!.dispose();
            },
          }),
        ),
      ),
    );
    scopes.forEach((scope, i) => scope.get(tokens[i]!));

    await scopes[0]!.dispose();
    await root.dispose();
  });

  it("disposers of two separate apps awaiting each other's dispose() don't deadlock", async () => {
    const X = createSyncToken<object>("crossAppX");
    const Y = createSyncToken<object>("crossAppY");
    const firstApp = new Container();
    const secondApp = new Container();
    firstApp.load(
      createModule((m) =>
        m.single(X, () => ({}), {
          dispose: async () => {
            await Promise.resolve();
            await secondApp.dispose();
          },
        }),
      ),
    );
    secondApp.load(
      createModule((m) =>
        m.single(Y, () => ({}), {
          dispose: async () => {
            await Promise.resolve();
            await firstApp.dispose();
          },
        }),
      ),
    );
    firstApp.get(X);
    secondApp.get(Y);

    await firstApp.dispose();
  });

  it("a disposer awaiting another scope's dispose() still waits for it when there is no cycle", async () => {
    const A = createSyncToken<object>("noCycleA");
    const B = createSyncToken<object>("noCycleB");
    const bDisposerGate = createGate();
    const events: string[] = [];
    const root = new Container();
    const scopeA = root.createScope();
    const scopeB = root.createScope();
    root.load(
      createModule((m) => {
        m.scoped(A, () => ({}), {
          dispose: async () => {
            await scopeB.dispose();
            events.push("A saw B finish");
          },
        });
        m.scoped(B, () => ({}), {
          dispose: async () => {
            await bDisposerGate.opened;
            events.push("B finished");
          },
        });
      }),
    );
    scopeA.get(A);
    scopeB.get(B);

    const scopeADisposal = scopeA.dispose();
    await delay(0);
    expect(events).toEqual([]);
    bDisposerGate.open();
    await scopeADisposal;
    expect(events).toEqual(["B finished", "A saw B finish"]);
  });

  it("a cycle that runs through a nested scope's disposer doesn't deadlock", async () => {
    const RequestConn = createSyncToken<object>("nestedCycleConn");
    const Y = createSyncToken<object>("nestedCycleY");
    const firstApp = new Container();
    const secondApp = new Container();
    firstApp.load(
      createModule((m) =>
        m.scoped(RequestConn, () => ({}), {
          dispose: async () => {
            await Promise.resolve();
            await secondApp.dispose();
          },
        }),
      ),
    );
    secondApp.load(
      createModule((m) =>
        m.single(Y, () => ({}), {
          dispose: async () => {
            await Promise.resolve();
            await firstApp.dispose(); // firstApp waits on its request scope, which waits on secondApp
          },
        }),
      ),
    );
    secondApp.get(Y);
    const requestScope = firstApp.createScope();
    requestScope.get(RequestConn);

    await requestScope.dispose();
    await firstApp.dispose();
  });

  it("waits shared through a diamond are not mistaken for a cycle", async () => {
    const [T, C, D, E, W] = ["T", "C", "D", "E", "W"].map((name) => createSyncToken<object>(`diamond${name}`));
    const eDisposerGate = createGate();
    const events: string[] = [];
    const root = new Container();
    const [scopeT, scopeC, scopeD, scopeE, scopeW] = [T, C, D, E, W].map(() => root.createScope());
    root.load(
      createModule((m) => {
        m.scoped(T!, () => ({}), {
          dispose: async () => void (await Promise.all([scopeC!.dispose(), scopeD!.dispose()])),
        });
        m.scoped(C!, () => ({}), { dispose: () => scopeE!.dispose() });
        m.scoped(D!, () => ({}), { dispose: () => scopeE!.dispose() });
        m.scoped(E!, () => ({}), {
          dispose: async () => {
            await eDisposerGate.opened;
            events.push("E finished");
          },
        });
        m.scoped(W!, () => ({}), {
          dispose: async () => {
            await scopeT!.dispose(); // T waits on C and D, which both wait on E: no path back to W
            events.push("W saw T finish");
          },
        });
      }),
    );
    [scopeT, scopeC, scopeD, scopeE, scopeW].forEach((scope, i) => scope!.get([T, C, D, E, W][i]!));

    const scopeTDisposal = scopeT!.dispose();
    await delay(0);
    const scopeWDisposal = scopeW!.dispose();
    await delay(0);
    expect(events, "W must wait: nothing in T's waits leads back to it").toEqual([]);
    eDisposerGate.open();

    await Promise.all([scopeTDisposal, scopeWDisposal]);
    expect(events).toEqual(["E finished", "W saw T finish"]);
    await root.dispose();
  });

  it("a disposer's dispose() of a sibling scope in the same tree is an ordinary call", async () => {
    const Tx = createSyncToken<object>("siblingTx");
    const Log = createSyncToken<object>("siblingLog");
    const events: string[] = [];
    const root = new Container();
    const sibling = root.createScope();
    root.load(
      createModule((m) => {
        m.scoped(Tx, () => ({}), { dispose: () => sibling.dispose() });
        m.scoped(Log, () => ({}), { dispose: () => void events.push("sibling disposed") });
      }),
    );
    sibling.get(Log);
    const scope = root.createScope();
    scope.get(Tx);

    await scope.dispose();
    expect(events).toEqual(["sibling disposed"]);
    await root.dispose();
  });

  it("a disposer's dispose() of an unrelated container tree is an ordinary call", async () => {
    const T = createSyncToken<object>("otherTree");
    const Other = createSyncToken<object>("otherTreeEntry");
    const events: string[] = [];
    const other = new Container();
    other.load(createModule((m) => m.single(Other, () => ({}), { dispose: () => void events.push("other disposed") })));
    other.get(Other);
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => ({}), { dispose: () => other.dispose() })));
    c.get(T);

    await c.dispose();
    expect(events).toEqual(["other disposed"]);
  });

  it("an orphan disposer awaiting its container's dispose() does not deadlock teardown", async () => {
    const T = createAsyncToken<object>("orphanAwait");
    const providerGate = createGate();
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(
          T,
          async () => {
            await providerGate.opened;
            return {};
          },
          { dispose: () => c.dispose() },
        ),
      ),
    );
    const orphaned = ignore(c.getAsync(T));
    const disposal = c.dispose();
    providerGate.open();

    await expect(orphaned).rejects.toThrowError(DisposedContainerError);
    await disposal;
  });

  it("unload is rejected while a scope is disposing, and allowed once it finishes", async () => {
    const Config = createSyncToken<number>("unloadConfig");
    const Tx = createSyncToken<object>("unloadTx");
    const disposerGate = createGate();
    const configModule = createModule((m) => m.single(Config, () => 1));
    const root = new Container();
    root.load(configModule);
    root.load(createModule((m) => m.scoped(Tx, () => ({}), { dispose: () => disposerGate.opened })));
    const scope = root.createScope();
    scope.get(Tx);

    const scopeDisposal = scope.dispose();
    await expect(root.unload(configModule)).rejects.toThrowError(LifecycleOperationError);

    disposerGate.open();
    await scopeDisposal;
    await root.unload(configModule);
    expect(root.has(Config)).toBe(false);
  });
});

// A mutual async cycle resolved by a SINGLE call descends the whole loop on one
// chain, so the per-chain circular check catches it. Two CONCURRENT calls each
// register one half before descending, so each coalesces onto the other's
// in-flight promise and neither chain ever holds the full loop — without the
// wait-for graph these await each other forever. Cycles like these are
// unwritable through the typed composition API; they are reachable only at the
// raw engine level (deep import + raw tokens), which is what these exercise.
describe("concurrency: async cycle detection", () => {
  const expectAllCircular = (results: PromiseSettledResult<unknown>[]): void => {
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(CircularDependencyError);
    }
  };

  it("concurrent mutual async-singleton cycle throws instead of deadlocking", { timeout: 2000 }, async () => {
    const A = createAsyncToken<string>("cycA");
    const B = createAsyncToken<string>("cycB");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.singleAsync(A, async (r) => {
          await delay(5); // yield BEFORE requesting the peer — the deadlock-prone shape
          return `A:${await r.getAsync(B)}`;
        });
        m.singleAsync(B, async (r) => {
          await delay(5);
          return `B:${await r.getAsync(A)}`;
        });
      }),
    );
    expectAllCircular(await Promise.allSettled([c.getAsync(A), c.getAsync(B)]));
  });

  it("concurrent 3-way async-singleton cycle throws instead of deadlocking", { timeout: 2000 }, async () => {
    const A = createAsyncToken<string>("c3A");
    const B = createAsyncToken<string>("c3B");
    const D = createAsyncToken<string>("c3C");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.singleAsync(A, async (r) => {
          await delay(5);
          return `A${await r.getAsync(B)}`;
        });
        m.singleAsync(B, async (r) => {
          await delay(5);
          return `B${await r.getAsync(D)}`;
        });
        m.singleAsync(D, async (r) => {
          await delay(5);
          return `C${await r.getAsync(A)}`;
        });
      }),
    );
    expectAllCircular(await Promise.allSettled([c.getAsync(A), c.getAsync(B), c.getAsync(D)]));
  });

  it("concurrent mutual scoped-async cycle on one scope throws instead of deadlocking", { timeout: 2000 }, async () => {
    const A = createAsyncToken<string>("scA");
    const B = createAsyncToken<string>("scB");
    const root = new Container();
    root.load(
      createModule((m) => {
        m.scopedAsync(A, async (r) => {
          await delay(5);
          return `A${await r.getAsync(B)}`;
        });
        m.scopedAsync(B, async (r) => {
          await delay(5);
          return `B${await r.getAsync(A)}`;
        });
      }),
    );
    const scope = root.createScope();
    expectAllCircular(await Promise.allSettled([scope.getAsync(A), scope.getAsync(B)]));
  });

  it("the thrown error names the full wait-for cycle", { timeout: 2000 }, async () => {
    const A = createAsyncToken<string>("nameA");
    const B = createAsyncToken<string>("nameB");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.singleAsync(A, async (r) => {
          await delay(5);
          return `A${await r.getAsync(B)}`;
        });
        m.singleAsync(B, async (r) => {
          await delay(5);
          return `B${await r.getAsync(A)}`;
        });
      }),
    );
    const [first] = await Promise.allSettled([c.getAsync(A), c.getAsync(B)]);
    const error = (first as PromiseRejectedResult).reason as CircularDependencyError;
    expect(error).toBeInstanceOf(CircularDependencyError);
    // The message lists both offending tokens and closes the loop back on itself.
    expect(error.message).toContain("nameA");
    expect(error.message).toContain("nameB");
    const path = (error.message.split("\n")[1] ?? "").split(" -> ");
    expect(path[0], "the cycle closes on the token it started from").toBe(path.at(-1));
  });

  it("a cycle mixing a synchronous descent with a coalesce is caught", { timeout: 2000 }, async () => {
    // A yields (so X starts concurrently), then descends B -> C synchronously
    // (no await before requesting the peer); C coalesces onto the in-flight X,
    // which loops back to A. The B->C build edges live on one chain and the
    // C->X / X->A coalesces on another, so only the full wait-for graph sees it.
    const A = createAsyncToken<unknown>("mixA");
    const B = createAsyncToken<unknown>("mixB");
    const C = createAsyncToken<unknown>("mixC");
    const X = createAsyncToken<unknown>("mixX");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.singleAsync(A, async (r) => {
          await delay(0);
          return r.getAsync(B);
        });
        m.singleAsync(B, (r) => r.getAsync(C)); // synchronous descent
        m.singleAsync(C, (r) => r.getAsync(X)); // synchronous descent -> coalesces onto X
        m.singleAsync(X, async (r) => {
          await delay(5);
          return r.getAsync(A);
        });
      }),
    );
    const results = await Promise.allSettled([c.getAsync(A), c.getAsync(X)]);
    expectAllCircular(results);
  });

  it(
    "treats getAsync inside a provider as a dependency even when its result is ignored",
    { timeout: 2000 },
    async () => {
      // CONTRACT (intentional, conservative): `resolver.getAsync(T)` inside a
      // provider declares a dependency on T whether or not the returned promise is
      // awaited. The engine tracks in-flight provider dependencies, not JavaScript
      // await timing (it cannot observe an await), so a provider that
      // fire-and-forgets getAsync of a peer that depends back forms a dependency
      // cycle and is reported circular — even though it would not deadlock at
      // runtime. Cycles are unwritable via the composition API; this is a
      // raw-engine concern. Delays are arranged so A declares its dependency on B
      // first and B closes the cycle (and does not swallow the error), making the
      // contract deterministically observable.
      const A = createAsyncToken<number>("ffA");
      const B = createAsyncToken<number>("ffB");
      const c = new Container();
      c.load(
        createModule((m) => {
          m.singleAsync(A, async (r) => {
            await delay(0);
            void r.getAsync(B).catch(() => {}); // fire-and-forget — still a declared dependency on B
            await delay(20);
            return 1;
          });
          m.singleAsync(B, async (r) => {
            await delay(10); // closes the A -> B -> A dependency cycle, after A declared its dep
            return r.getAsync(A);
          });
        }),
      );
      const [a, b] = await Promise.allSettled([c.getAsync(A), c.getAsync(B)]);
      // B's request for A closes the declared cycle and is rejected; A's own
      // completion does not depend on B, so A still resolves. No hang either way.
      expect(b.status).toBe("rejected");
      expect((b as PromiseRejectedResult).reason).toBeInstanceOf(CircularDependencyError);
      expect(a.status).toBe("fulfilled");
    },
  );

  it("concurrent resolution through a shared async dependency does not throw a false cycle", async () => {
    const Hub = createAsyncToken<number>("hub");
    const X = createAsyncToken<number>("hubX");
    const Y = createAsyncToken<number>("hubY");
    let hubBuilds = 0;
    const c = new Container();
    c.load(
      createModule((m) => {
        m.singleAsync(Hub, async () => {
          hubBuilds += 1;
          await delay(10);
          return 1;
        });
        m.singleAsync(X, async (r) => {
          await delay(2);
          return (await r.getAsync(Hub)) + 10;
        });
        m.singleAsync(Y, async (r) => {
          await delay(2);
          return (await r.getAsync(Hub)) + 20;
        });
      }),
    );
    // X and Y each coalesce onto the still-in-flight Hub from inside their own
    // providers (waiter present, no cycle) — the legitimate case the fix must
    // NOT reject.
    const [x, y, h] = await Promise.all([c.getAsync(X), c.getAsync(Y), c.getAsync(Hub)]);
    expect(hubBuilds, "Hub builds exactly once under concurrency").toBe(1);
    expect([x, y, h]).toEqual([11, 21, 1]);
  });

  it("an async factory between a singleton and a concurrently-built peer is transparent to wait tracking", async () => {
    const W = createAsyncToken<string>("ftW");
    const Fac = createAsyncToken<string>("ftFac");
    const C = createAsyncToken<string>("ftC");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.singleAsync(W, async (r) => {
          await delay(2);
          return `W:${await r.getAsync(Fac)}`;
        });
        m.factoryAsync(Fac, async (r) => {
          await delay(2);
          return `F:${await r.getAsync(C)}`;
        });
        m.singleAsync(C, async () => {
          await delay(30); // still in flight when Fac coalesces onto it
          return "C";
        });
      }),
    );
    // The coalesce happens with a factory frame directly above C; the waiter must
    // skip the factory and be attributed to the singleton W above it.
    const [w, c2] = await Promise.all([c.getAsync(W), c.getAsync(C)]);
    expect([w, c2]).toEqual(["W:F:C", "C"]);
  });

  it("a detected concurrent cycle does not poison later resolutions on the same container", async () => {
    const A = createAsyncToken<string>("poiA");
    const B = createAsyncToken<string>("poiB");
    const Ok = createAsyncToken<string>("poiOk");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.singleAsync(A, async (r) => {
          await delay(5);
          return `A${await r.getAsync(B)}`;
        });
        m.singleAsync(B, async (r) => {
          await delay(5);
          return `B${await r.getAsync(A)}`;
        });
        m.singleAsync(Ok, async () => "ok");
      }),
    );
    expectAllCircular(await Promise.allSettled([c.getAsync(A), c.getAsync(B)]));
    // The wait-for edges tore down with the rejected resolutions, so the graph is
    // empty again: an unrelated token resolves, and a fresh single-call attempt
    // at the cycle is still caught (now by the per-chain check).
    expect(await c.getAsync(Ok)).toBe("ok");
    await expect(c.getAsync(A)).rejects.toBeInstanceOf(CircularDependencyError);
  });

  it("randomized concurrent DAGs of async singletons never throw a false cycle", async () => {
    const trials = 60;
    for (let trial = 0; trial < trials; trial += 1) {
      const size = 3 + Math.floor(random() * 5);
      const tokens = Array.from({ length: size }, (_, i) => createAsyncToken<number>(`dag${trial}_${i}`));
      const c = new Container();
      c.load(
        createModule((m) => {
          tokens.forEach((token, i) => {
            // Edges only point to higher indices, so the graph is always acyclic.
            const deps = tokens.slice(i + 1).filter(() => random() < 0.5);
            m.singleAsync(token, async (r) => {
              await delay(random() * 3); // yield before requesting peers
              let sum = i;
              for (const dep of deps) sum += await r.getAsync(dep);
              return sum;
            });
          });
        }),
      );
      const results = await Promise.allSettled(tokens.map((token) => c.getAsync(token)));
      for (const result of results) {
        expect(result.status, `acyclic trial ${trial} must fully resolve (no false positive)`).toBe("fulfilled");
      }
      await c.dispose();
    }
  });

  it(
    "randomized concurrent cyclic graphs settle without hanging, only throwing CircularDependencyError",
    { timeout: 15_000 },
    async () => {
      const trials = 80;
      let sawRejection = false;
      for (let trial = 0; trial < trials; trial += 1) {
        const size = 2 + Math.floor(random() * 5);
        const tokens = Array.from({ length: size }, (_, i) => createAsyncToken<number>(`cyc${trial}_${i}`));
        const c = new Container();
        c.load(
          createModule((m) => {
            tokens.forEach((token, i) => {
              // Edges to ANY other node, so graphs may contain cycles.
              const deps = tokens.filter((_, j) => j !== i && random() < 0.45);
              // Half the providers descend synchronously (no yield before
              // requesting peers), so cycles can mix build edges with coalesces.
              const yields = random() < 0.5;
              m.singleAsync(token, async (r) => {
                if (yields) await delay(random() * 2);
                let sum = i;
                for (const dep of deps) sum += await r.getAsync(dep);
                return sum;
              });
            });
          }),
        );
        // If the fix is correct this always settles; a hang would trip the timeout.
        const results = await Promise.allSettled(tokens.map((token) => c.getAsync(token)));
        for (const result of results) {
          if (result.status === "rejected") {
            sawRejection = true;
            expect(result.reason, `cyclic trial ${trial}: only framework cycle errors`).toBeInstanceOf(
              CircularDependencyError,
            );
          }
        }
        await c.dispose();
      }
      expect(sawRejection, "the randomized graphs must have actually hit cycles").toBe(true);
    },
  );
});
