import { describe, expect, it } from "vitest";

import { Container, createAsyncToken, createModule, createSyncToken, isAsyncToken } from "../internal-api";
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
} from "../internal-api";

describe("errors: guardrails", () => {
  it("missing dependency throws MissingDependencyError", async () => {
    const T = createSyncToken<number>("missing");
    const c = new Container();
    expect(() => c.get(T)).toThrowError(MissingDependencyError);
  });

  it("direct circular dependency is detected", async () => {
    const A = createSyncToken<unknown>("cA");
    const B = createSyncToken<unknown>("cB");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, (r) => ({ b: r.get(B) }));
        m.single(B, (r) => ({ a: r.get(A) }));
      }),
    );
    expect(() => c.get(A)).toThrowError(CircularDependencyError);
  });

  it("deep circular dependency is detected", async () => {
    const A = createSyncToken<unknown>("dcA");
    const B = createSyncToken<unknown>("dcB");
    const D = createSyncToken<unknown>("dcC");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, (r) => r.get(B));
        m.single(B, (r) => r.get(D));
        m.single(D, (r) => r.get(A));
      }),
    );
    expect(() => c.get(A)).toThrowError(CircularDependencyError);
  });

  it("singleton depending on scoped throws CaptiveDependencyError", async () => {
    const Svc = createSyncToken<unknown>("capSvc");
    const Ctx = createSyncToken<unknown>("capCtx");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(Svc, (r) => ({ ctx: r.get(Ctx) }));
        m.scoped(Ctx, () => ({}));
      }),
    );
    expect(() => c.get(Svc)).toThrowError(CaptiveDependencyError);
  });

  it("transitive singleton -> factory -> scoped is captive", async () => {
    const Svc = createSyncToken<unknown>("tcapSvc");
    const Fac = createSyncToken<unknown>("tcapFac");
    const Ctx = createSyncToken<unknown>("tcapCtx");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(Svc, (r) => ({ f: r.get(Fac) }));
        m.factory(Fac, (r) => ({ c: r.get(Ctx) }));
        m.scoped(Ctx, () => ({}));
      }),
    );
    expect(() => c.get(Svc)).toThrowError(CaptiveDependencyError);
  });

  it("factory -> scoped (no singleton ancestor) is allowed", () => {
    const Fac = createSyncToken<{ c: unknown }>("okFac");
    const Ctx = createSyncToken<unknown>("okCtx");
    const root = new Container();
    root.load(
      createModule((m) => {
        m.factory(Fac, (r) => ({ c: r.get(Ctx) }));
        m.scoped(Ctx, () => ({}));
      }),
    );
    const scope = root.createScope();
    expect(scope.get(Fac).c !== undefined).toBeTruthy();
  });

  it("child cannot shadow an ancestor token", async () => {
    const T = createSyncToken<number>("shUp");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => 1)));
    const child = root.createScope();
    expect(() => child.load(createModule((m) => m.single(T, () => 2)))).toThrowError(ShadowedDefinitionError);
  });

  it("ancestor cannot define a token already in a descendant", async () => {
    const T = createSyncToken<number>("shDown");
    const root = new Container();
    const child = root.createScope();
    child.load(createModule((m) => m.single(T, () => 1)));
    expect(() => root.load(createModule((m) => m.single(T, () => 2)))).toThrowError(ShadowedDefinitionError);
  });

  it("provider construction error is wrapped with token context", async () => {
    const T = createSyncToken<number>("wrap");
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
    expect(err instanceof ProviderExecutionError, "expected ProviderExecutionError").toBeTruthy();
    expect(
      (err as ProviderExecutionError).cause instanceof Error &&
        ((err as ProviderExecutionError).cause as Error).message === "inner",
      "original cause must be preserved",
    ).toBeTruthy();
  });

  it("framework errors are not re-wrapped as provider errors", async () => {
    const A = createSyncToken<unknown>("nwA");
    const Missing = createSyncToken<unknown>("nwMissing");
    const c = new Container();
    c.load(createModule((m) => m.single(A, (r) => r.get(Missing))));
    expect(() => c.get(A)).toThrowError(MissingDependencyError);
  });

  it("a child cannot resolve through a disposed ancestor", async () => {
    const T = createSyncToken<number>("discAnc");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => 5)));
    const child = root.createScope();
    await root.dispose();
    expect(() => child.get(T)).toThrowError(DisposedContainerError);
  });

  it("getAsync() of a sync provider throws SyncProviderError (runtime backstop)", async () => {
    const T = createSyncToken<number>("sMisuse");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    // The token brand makes this a compile error now; cast to exercise the
    // runtime backstop that still protects untyped/JS callers.
    await expect(c.getAsync(T as unknown as AsyncToken<number>)).rejects.toThrowError(SyncProviderError);
  });

  it("token brands reject sync/async misuse at compile time", () => {
    const S = createSyncToken<number>("brandSync");
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
      // @ts-expect-error a structural look-alike cannot impersonate a token (brand is unexported)
      c.get({ description: "forged", mode: "sync" });
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
    expect(c.has(S)).toBe(false);
    expect(c.has(A)).toBe(false);
    // The mode discriminant is real at runtime, not just a type-level brand.
    expect(isAsyncToken(S)).toBe(false);
    expect(isAsyncToken(A)).toBe(true);
    expect(S.description).toBe("brandSync");
  });

  it("all framework errors extend DIError", () => {
    const errs: Error[] = [
      new MissingDependencyError("x"),
      new CircularDependencyError(["a", "b"]),
      new CaptiveDependencyError("a", "b"),
      new ShadowedDefinitionError("x"),
      new ProviderExecutionError("x", new Error()),
      new DisposedContainerError(),
    ];
    expect(errs.every((e) => e instanceof DIError)).toBeTruthy();
    expect(new Error("plain") instanceof DIError).toBe(false);
  });
});
