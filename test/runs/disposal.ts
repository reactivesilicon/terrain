import { Container, createModule, createToken } from "../../src"
import { DisposedContainerError } from "../../src"
import { suite, assert, assertEqual, assertThrows, isInstance, delay } from "../harness"

suite("disposal", (test) => {
  test("disposes in reverse creation order", async () => {
    const Db = createToken<{ dispose(): void }>("db")
    const Repo = createToken<{ dispose(): void }>("repo")
    const order: string[] = []
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(Db, () => ({ dispose: () => order.push("db") }))
        m.single(Repo, (r) => {
          r.get(Db)
          return { dispose: () => order.push("repo") }
        })
      }),
    )
    c.get(Repo)
    await c.dispose()
    assertEqual(order.join(","), "repo,db")
  })

  test("singleton disposable is disposed", async () => {
    const T = createToken<{ dispose(): void }>("singleDisp")
    let n = 0
    const c = new Container()
    c.load(createModule((m) => m.single(T, () => ({ dispose: () => n++ }))))
    c.get(T)
    await c.dispose()
    assertEqual(n, 1)
  })

  test("factory instances are not auto-tracked for disposal", async () => {
    const T = createToken<{ dispose(): void }>("factoryDisp")
    let n = 0
    const c = new Container()
    c.load(createModule((m) => m.factory(T, () => ({ dispose: () => n++ }))))
    for (let i = 0; i < 500; i++) c.get(T)
    await c.dispose()
    assertEqual(n, 0, "factories are caller-owned")
  })

  test("dispose is idempotent", async () => {
    const T = createToken<{ dispose(): void }>("idem")
    let n = 0
    const c = new Container()
    c.load(createModule((m) => m.single(T, () => ({ dispose: () => n++ }))))
    c.get(T)
    await c.dispose()
    await c.dispose()
    await c.dispose()
    assertEqual(n, 1)
  })

  test("concurrent dispose calls do not double-dispose or throw", async () => {
    const T = createToken<{ dispose(): void }>("concDisp")
    let n = 0
    const c = new Container()
    c.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          await delay(10)
          return { dispose: () => n++ }
        }),
      ),
    )
    await c.getAsync(T)
    const results = await Promise.allSettled([c.dispose(), c.dispose()])
    assert(!results.some((r) => r.status === "rejected"), "neither dispose should reject")
    assertEqual(n, 1)
  })

  test("disposing root cascades to child scopes", async () => {
    const T = createToken<{ dispose(): void }>("cascade")
    let n = 0
    const root = new Container()
    root.load(createModule((m) => m.scoped(T, () => ({ dispose: () => n++ }))))
    const scope = root.createScope()
    scope.get(T)
    await root.dispose()
    assertEqual(n, 1)
  })

  test("a disposed container rejects further resolution", async () => {
    const T = createToken<number>("postDispose")
    const c = new Container()
    c.load(createModule((m) => m.single(T, () => 1)))
    await c.dispose()
    await assertThrows(() => c.get(T), isInstance(DisposedContainerError))
    await assertThrows(() => c.has(T), isInstance(DisposedContainerError))
    await assertThrows(() => c.inject(T), isInstance(DisposedContainerError))
  })

  test("onDisposeError observes orphan disposal failure without altering rejection", async () => {
    const T = createToken<{ dispose(): void }>("orphanHook")
    let hookError: unknown = null
    const c = new Container({
      onDisposeError: (e) => {
        hookError = e
      },
    })
    c.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          await delay(30)
          return {
            dispose: () => {
              throw new Error("orphan-dispose")
            },
          }
        }),
      ),
    )
    const p = c.getAsync(T)
    let rejection: unknown
    p.catch((e) => {
      rejection = e
    })
    await delay(5)
    await c.dispose()
    await delay(10)
    assert(rejection instanceof DisposedContainerError, "caller sees DisposedContainerError")
    assert(
      hookError instanceof Error && hookError.message === "orphan-dispose",
      "hook observes the disposal failure",
    )
  })

  test("a throwing onDisposeError does not change the rejection type", async () => {
    const T = createToken<{ dispose(): void }>("hookThrows")
    const c = new Container({
      onDisposeError: () => {
        throw new Error("hook boom")
      },
    })
    c.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          await delay(30)
          return {
            dispose: () => {
              throw new Error("disp")
            },
          }
        }),
      ),
    )
    const p = c.getAsync(T)
    let rejection: unknown
    p.catch((e) => {
      rejection = e
    })
    await delay(5)
    await c.dispose()
    await delay(10)
    assert(rejection instanceof DisposedContainerError)
  })

  test("dispose collects disposal errors into an AggregateError", async () => {
    const T = createToken<{ dispose(): void }>("disposeThrows")
    const c = new Container()
    c.load(createModule((m) => m.single(T, () => ({
      dispose: () => { throw new Error("boom") },
    }))))
    c.get(T)
    let caught: unknown
    try {
      await c.dispose()
    } catch (e) {
      caught = e
    }
    assert(caught instanceof AggregateError, "dispose must reject with AggregateError")
    assert(
      (caught as AggregateError).errors.some(
        (x) => x instanceof Error && x.message === "boom",
      ),
      "original disposal error must be present",
    )
  })

  test("disposes a 3-chain in reverse creation order", async () => {
    const A = createToken<{ dispose(): void }>("a3")
    const B = createToken<{ dispose(): void }>("b3")
    const D = createToken<{ dispose(): void }>("c3")
    const order: string[] = []
    const c = new Container()
    c.load(createModule((m) => {
      m.single(A, () => ({ dispose: () => order.push("a") }))
      m.single(B, (r) => { r.get(A); return { dispose: () => order.push("b") } })
      m.single(D, (r) => { r.get(B); return { dispose: () => order.push("c") } })
    }))
    c.get(D) // creation order a, b, c
    await c.dispose()
    assertEqual(order.join(","), "c,b,a")
  })

  test("one throwing disposal does not prevent the others", async () => {
    const A = createToken<{ dispose(): void }>("aFail")
    const B = createToken<{ dispose(): void }>("bFail")
    const D = createToken<{ dispose(): void }>("cFail")
    const disposed: string[] = []
    const c = new Container()
    c.load(createModule((m) => {
      m.single(A, () => ({ dispose: () => disposed.push("a") }))
      m.single(B, (r) => {
        r.get(A)
        return { dispose: () => { throw new Error("middle") } }
      })
      m.single(D, (r) => { r.get(B); return { dispose: () => disposed.push("c") } })
    }))
    c.get(D)
    let caught: unknown
    try {
      await c.dispose()
    } catch (e) {
      caught = e
    }
    assertEqual(disposed.sort().join(","), "a,c", "non-throwing disposables still disposed")
    assert(
      caught instanceof AggregateError &&
      caught.errors.some((x) => x instanceof Error && x.message === "middle"),
      "the failure is surfaced",
    )
  })

  test("mixed singleton and scoped disposables dispose in reverse creation order", async () => {
    const Single = createToken<{ dispose(): void }>("mixSingle")
    const Scoped = createToken<{ dispose(): void }>("mixScoped")
    const order: string[] = []
    const root = new Container()
    root.load(createModule((m) => {
      m.single(Single, () => ({ dispose: () => order.push("single") }))
      m.scoped(Scoped, (r) => {
        r.get(Single) // single created first
        return { dispose: () => order.push("scoped") }
      })
    }))
    const scope = root.createScope()
    scope.get(Scoped)
    await scope.dispose()
    // scope disposes its own scoped instance; single lives on root, untouched here
    assertEqual(order.join(","), "scoped")
    await root.dispose()
    assertEqual(order.join(","), "scoped,single")
  })

  test("unload disposes evicted instances in reverse creation order", async () => {
    const A = createToken<{ dispose(): void }>("ulA")
    const B = createToken<{ dispose(): void }>("ulB")
    const order: string[] = []
    const mod = createModule((m) => {
      m.single(A, () => ({ dispose: () => order.push("a") }))
      m.single(B, (r) => { r.get(A); return { dispose: () => order.push("b") } })
    })
    const c = new Container()
    c.load(mod)
    c.get(B) // creation order a, b
    await c.unload(mod)
    assertEqual(order.join(","), "b,a")
  })
})