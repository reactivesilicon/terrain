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
})