import { describe, expect, it } from "vitest";

import { DisposedContainerError } from "../../src";
import { delay, ignore, random } from "../helpers";
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
