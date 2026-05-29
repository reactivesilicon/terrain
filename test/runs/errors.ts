import { Container, createModule, createToken } from "../../src"
import {
  CaptiveDependencyError,
  CircularDependencyError,
  DIError,
  DisposedContainerError,
  MissingDependencyError,
  ProviderExecutionError,
  ShadowedDefinitionError,
} from "../../src"
import { suite, assert, assertEqual, assertThrows, isInstance } from "../harness"

suite("errors: guardrails", (test) => {
  test("missing dependency throws MissingDependencyError", async () => {
    const T = createToken<number>("missing")
    const c = new Container()
    await assertThrows(() => c.get(T), isInstance(MissingDependencyError))
  })

  test("direct circular dependency is detected", async () => {
    const A = createToken<unknown>("cA")
    const B = createToken<unknown>("cB")
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(A, (r) => ({ b: r.get(B) }))
        m.single(B, (r) => ({ a: r.get(A) }))
      }),
    )
    await assertThrows(() => c.get(A), isInstance(CircularDependencyError))
  })

  test("deep circular dependency is detected", async () => {
    const A = createToken<unknown>("dcA")
    const B = createToken<unknown>("dcB")
    const D = createToken<unknown>("dcC")
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(A, (r) => r.get(B))
        m.single(B, (r) => r.get(D))
        m.single(D, (r) => r.get(A))
      }),
    )
    await assertThrows(() => c.get(A), isInstance(CircularDependencyError))
  })

  test("singleton depending on scoped throws CaptiveDependencyError", async () => {
    const Svc = createToken<unknown>("capSvc")
    const Ctx = createToken<unknown>("capCtx")
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(Svc, (r) => ({ ctx: r.get(Ctx) }))
        m.scoped(Ctx, () => ({}))
      }),
    )
    await assertThrows(() => c.get(Svc), isInstance(CaptiveDependencyError))
  })

  test("transitive singleton -> factory -> scoped is captive", async () => {
    const Svc = createToken<unknown>("tcapSvc")
    const Fac = createToken<unknown>("tcapFac")
    const Ctx = createToken<unknown>("tcapCtx")
    const c = new Container()
    c.load(
      createModule((m) => {
        m.single(Svc, (r) => ({ f: r.get(Fac) }))
        m.factory(Fac, (r) => ({ c: r.get(Ctx) }))
        m.scoped(Ctx, () => ({}))
      }),
    )
    await assertThrows(() => c.get(Svc), isInstance(CaptiveDependencyError))
  })

  test("factory -> scoped (no singleton ancestor) is allowed", () => {
    const Fac = createToken<{ c: unknown }>("okFac")
    const Ctx = createToken<unknown>("okCtx")
    const root = new Container()
    root.load(
      createModule((m) => {
        m.factory(Fac, (r) => ({ c: r.get(Ctx) }))
        m.scoped(Ctx, () => ({}))
      }),
    )
    const scope = root.createScope()
    assert(scope.get(Fac).c !== undefined)
  })

  test("child cannot shadow an ancestor token", async () => {
    const T = createToken<number>("shUp")
    const root = new Container()
    root.load(createModule((m) => m.single(T, () => 1)))
    const child = root.createScope()
    await assertThrows(
      () => child.load(createModule((m) => m.single(T, () => 2))),
      isInstance(ShadowedDefinitionError),
    )
  })

  test("ancestor cannot define a token already in a descendant", async () => {
    const T = createToken<number>("shDown")
    const root = new Container()
    const child = root.createScope()
    child.load(createModule((m) => m.single(T, () => 1)))
    await assertThrows(
      () => root.load(createModule((m) => m.single(T, () => 2))),
      isInstance(ShadowedDefinitionError),
    )
  })

  test("provider construction error is wrapped with token context", async () => {
    const T = createToken<number>("wrap")
    const c = new Container()
    c.load(createModule((m) => m.single(T, () => {
      throw new Error("inner")
    })))
    let err: unknown
    try {
      c.get(T)
    } catch (e) {
      err = e
    }
    assert(err instanceof ProviderExecutionError, "expected ProviderExecutionError")
    assert(
      (err as ProviderExecutionError).cause instanceof Error &&
      ((err as ProviderExecutionError).cause as Error).message === "inner",
      "original cause must be preserved",
    )
  })

  test("framework errors are not re-wrapped as provider errors", async () => {
    const A = createToken<unknown>("nwA")
    const Missing = createToken<unknown>("nwMissing")
    const c = new Container()
    c.load(createModule((m) => m.single(A, (r) => r.get(Missing))))
    await assertThrows(() => c.get(A), isInstance(MissingDependencyError))
  })

  test("a child cannot resolve through a disposed ancestor", async () => {
    const T = createToken<number>("discAnc")
    const root = new Container()
    root.load(createModule((m) => m.single(T, () => 5)))
    const child = root.createScope()
    await root.dispose()
    await assertThrows(() => child.get(T), isInstance(DisposedContainerError))
  })

  test("all framework errors extend DIError", () => {
    const errs: Error[] = [
      new MissingDependencyError("x"),
      new CircularDependencyError(["a", "b"]),
      new CaptiveDependencyError("a", "b"),
      new ShadowedDefinitionError("x"),
      new ProviderExecutionError("x", new Error()),
      new DisposedContainerError(),
    ]
    assert(errs.every((e) => e instanceof DIError))
    assertEqual(new Error("plain") instanceof DIError, false)
  })
})