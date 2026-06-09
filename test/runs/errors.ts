import { Container, createAsyncToken, createModule, createToken } from "../../src";
import {
  type AsyncResolver,
  type AsyncToken,
  CaptiveDependencyError,
  CircularDependencyError,
  DIError,
  DisposedContainerError,
  MissingDependencyError,
  ProviderExecutionError,
  ShadowedDefinitionError,
  SyncProviderError,
  type SyncResolver,
} from "../../src";
import { suite, assert, assertEqual, assertThrows, isInstance } from "../harness";

suite("errors: guardrails", (test) => {
  test("missing dependency throws MissingDependencyError", async () => {
    const T = createToken<number>("missing");
    const c = new Container();
    await assertThrows(() => c.get(T), isInstance(MissingDependencyError));
  });

  test("direct circular dependency is detected", async () => {
    const A = createToken<unknown>("cA");
    const B = createToken<unknown>("cB");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, (r) => ({ b: r.get(B) }));
        m.single(B, (r) => ({ a: r.get(A) }));
      }),
    );
    await assertThrows(() => c.get(A), isInstance(CircularDependencyError));
  });

  test("deep circular dependency is detected", async () => {
    const A = createToken<unknown>("dcA");
    const B = createToken<unknown>("dcB");
    const D = createToken<unknown>("dcC");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, (r) => r.get(B));
        m.single(B, (r) => r.get(D));
        m.single(D, (r) => r.get(A));
      }),
    );
    await assertThrows(() => c.get(A), isInstance(CircularDependencyError));
  });

  test("singleton depending on scoped throws CaptiveDependencyError", async () => {
    const Svc = createToken<unknown>("capSvc");
    const Ctx = createToken<unknown>("capCtx");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(Svc, (r) => ({ ctx: r.get(Ctx) }));
        m.scoped(Ctx, () => ({}));
      }),
    );
    await assertThrows(() => c.get(Svc), isInstance(CaptiveDependencyError));
  });

  test("transitive singleton -> factory -> scoped is captive", async () => {
    const Svc = createToken<unknown>("tcapSvc");
    const Fac = createToken<unknown>("tcapFac");
    const Ctx = createToken<unknown>("tcapCtx");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(Svc, (r) => ({ f: r.get(Fac) }));
        m.factory(Fac, (r) => ({ c: r.get(Ctx) }));
        m.scoped(Ctx, () => ({}));
      }),
    );
    await assertThrows(() => c.get(Svc), isInstance(CaptiveDependencyError));
  });

  test("factory -> scoped (no singleton ancestor) is allowed", () => {
    const Fac = createToken<{ c: unknown }>("okFac");
    const Ctx = createToken<unknown>("okCtx");
    const root = new Container();
    root.load(
      createModule((m) => {
        m.factory(Fac, (r) => ({ c: r.get(Ctx) }));
        m.scoped(Ctx, () => ({}));
      }),
    );
    const scope = root.createScope();
    assert(scope.get(Fac).c !== undefined);
  });

  test("child cannot shadow an ancestor token", async () => {
    const T = createToken<number>("shUp");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => 1)));
    const child = root.createScope();
    await assertThrows(
      () => child.load(createModule((m) => m.single(T, () => 2))),
      isInstance(ShadowedDefinitionError),
    );
  });

  test("ancestor cannot define a token already in a descendant", async () => {
    const T = createToken<number>("shDown");
    const root = new Container();
    const child = root.createScope();
    child.load(createModule((m) => m.single(T, () => 1)));
    await assertThrows(() => root.load(createModule((m) => m.single(T, () => 2))), isInstance(ShadowedDefinitionError));
  });

  test("provider construction error is wrapped with token context", async () => {
    const T = createToken<number>("wrap");
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(T, () => {
          throw new Error("inner");
        }),
      ),
    );
    let err: unknown;
    try {
      c.get(T);
    } catch (e) {
      err = e;
    }
    assert(err instanceof ProviderExecutionError, "expected ProviderExecutionError");
    assert(
      (err as ProviderExecutionError).cause instanceof Error &&
        ((err as ProviderExecutionError).cause as Error).message === "inner",
      "original cause must be preserved",
    );
  });

  test("framework errors are not re-wrapped as provider errors", async () => {
    const A = createToken<unknown>("nwA");
    const Missing = createToken<unknown>("nwMissing");
    const c = new Container();
    c.load(createModule((m) => m.single(A, (r) => r.get(Missing))));
    await assertThrows(() => c.get(A), isInstance(MissingDependencyError));
  });

  test("a child cannot resolve through a disposed ancestor", async () => {
    const T = createToken<number>("discAnc");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => 5)));
    const child = root.createScope();
    await root.dispose();
    await assertThrows(() => child.get(T), isInstance(DisposedContainerError));
  });

  test("getAsync() of a sync provider throws SyncProviderError (runtime backstop)", async () => {
    const T = createToken<number>("sMisuse");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    // The token brand makes this a compile error now; cast to exercise the
    // runtime backstop that still protects untyped/JS callers.
    await assertThrows(() => c.getAsync(T as unknown as AsyncToken<number>), isInstance(SyncProviderError));
  });

  test("token brands reject sync/async misuse at compile time", () => {
    const S = createToken<number>("brandSync");
    const A = createAsyncToken<number>("brandAsync");
    // Never executed — typecheck:test fails if any of these stops being an error.
    void function compileOnly(c: Container, sync: SyncResolver, async: AsyncResolver) {
      // @ts-expect-error get() rejects async tokens
      c.get(A);
      // @ts-expect-error a sync resolver's get() rejects async tokens
      sync.get(A);
      // @ts-expect-error a sync resolver's has() rejects async tokens (has(t) implies resolvable)
      sync.has(A);
      // An async resolver can check and resolve both kinds — must compile.
      async.has(S);
      async.has(A);
      async.get(S);
      void async.getAsync(A);
      // @ts-expect-error getAsync() rejects sync tokens
      c.getAsync(S);
      // @ts-expect-error inject() rejects async tokens
      c.inject(A);
      // @ts-expect-error injectAsync() rejects sync tokens
      c.injectAsync(S);
      createModule((m) => {
        // @ts-expect-error sync builder methods reject async tokens
        m.single(A, () => 1);
        // @ts-expect-error async builder methods reject sync tokens
        m.singleAsync(S, async () => 1);
        // @ts-expect-error sync builder methods reject async tokens
        m.factory(A, () => 1);
        // @ts-expect-error async builder methods reject sync tokens
        m.factoryAsync(S, async () => 1);
        // @ts-expect-error sync builder methods reject async tokens
        m.scoped(A, () => 1);
        // @ts-expect-error async builder methods reject sync tokens
        m.scopedAsync(S, async () => 1);
      });
    };
    // has() accepts both kinds — must compile without error.
    const c = new Container();
    assertEqual(c.has(S), false);
    assertEqual(c.has(A), false);
  });

  test("all framework errors extend DIError", () => {
    const errs: Error[] = [
      new MissingDependencyError("x"),
      new CircularDependencyError(["a", "b"]),
      new CaptiveDependencyError("a", "b"),
      new ShadowedDefinitionError("x"),
      new ProviderExecutionError("x", new Error()),
      new DisposedContainerError(),
    ];
    assert(errs.every((e) => e instanceof DIError));
    assertEqual(new Error("plain") instanceof DIError, false);
  });
});
