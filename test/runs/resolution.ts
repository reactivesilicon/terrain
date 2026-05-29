import { Container, createModule, createToken } from "../../src"
import { suite, assert, assertEqual } from "../harness"

suite("resolution", (test) => {
  test("providers receive a resolver and can pull dependencies", () => {
    const A = createToken<{ tag: string }>("A")
    const B = createToken<{ a: { tag: string } }>("B")
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(A, () => ({ tag: "a" }))
        m.single(B, (r) => ({ a: r.get(A) }))
      }),
    )
    assertEqual(c.get(B).a.tag, "a")
  })

  test("deep dependency chain resolves", () => {
    const A = createToken<{ n: number }>("dA")
    const B = createToken<{ n: number }>("dB")
    const D = createToken<{ n: number }>("dC")
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(A, () => ({ n: 1 }))
        m.single(B, (r) => ({ n: r.get(A).n + 1 }))
        m.single(D, (r) => ({ n: r.get(B).n + 1 }))
      }),
    )
    assertEqual(c.get(D).n, 3)
  })

  test("child resolves an ancestor-defined token", () => {
    const T = createToken<number>("anc")
    const root = new Container()
    root.load(createModule((m) => m.single(T, () => 9)))
    assertEqual(root.createScope().get(T), 9)
  })

  test("root singleton is shared across child scopes", () => {
    const T = createToken<object>("rootSingle")
    const root = new Container()
    root.load(createModule((m) => m.single(T, () => ({}))))
    const a = root.createScope()
    const b = root.createScope()
    assert(a.get(T) === b.get(T))
  })

  test("sibling scopes with their own definitions are isolated", () => {
    const T = createToken<number>("sib")
    const root = new Container()
    const a = root.createScope()
    const b = root.createScope()
    a.load(createModule((m) => m.single(T, () => 1)))
    b.load(createModule((m) => m.single(T, () => 2)))
    assertEqual(a.get(T), 1)
    assertEqual(b.get(T), 2)
  })

  test("sync provider's resolver does not expose getAsync at runtime", () => {
    const T = createToken<number>("noAsync")
    let hadGetAsync = true
    const c = new Container()
    c.load(
      createModule((m) =>
        m.single(T, (r) => {
          hadGetAsync = "getAsync" in (r as object)
          return 1
        }),
      ),
    )
    c.get(T)
    assertEqual(hadGetAsync, false, "SyncResolver must not carry getAsync")
  })

  test("has() reflects presence", () => {
    const T = createToken<number>("present")
    const U = createToken<number>("absent")
    const c = new Container()
    c.load(createModule((m) => m.single(T, () => 1)))
    assertEqual(c.has(T), true)
    assertEqual(c.has(U), false)
  })

  test("inject() is lazy and honors lifetime", () => {
    const S = createToken<object>("lazyS")
    const F = createToken<object>("lazyF")
    let built = 0
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(S, () => {
          built++
          return {}
        })
        m.factory(F, () => ({}))
      }),
    )
    const getS = c.inject(S)
    assertEqual(built, 0, "inject must not resolve until called")
    assert(getS() === getS(), "inject(singleton) returns the shared instance")
    assertEqual(built, 1)
    const getF = c.inject(F)
    assert(getF() !== getF(), "inject(factory) returns fresh instances")
  })
})