import { describe, expect, it } from "vitest";

import { delay } from "../helpers";
import { Container, createModule, createAsyncToken } from "../internal-api";
import { AsyncProviderError, type Token } from "../internal-api";

describe("async", () => {
  it("async singleton resolves once under concurrency", async () => {
    const T = createAsyncToken<{ n: number }>("aSingle");
    let builds = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          builds += 1;
          await delay(10);
          return { n: builds };
        }),
      ),
    );
    const [a, b, d] = await Promise.all([c.getAsync(T), c.getAsync(T), c.getAsync(T)]);
    expect(builds, "provider must run exactly once").toBe(1);
    expect(a === b && b === d, "all callers receive the same instance").toBeTruthy();
  });

  it("async scoped resolves once per scope under concurrency", async () => {
    const T = createAsyncToken<object>("aScoped");
    let builds = 0;
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scopedAsync(T, async () => {
          builds += 1;
          await delay(10);
          return {};
        }),
      ),
    );
    const scope = root.createScope();
    await Promise.all([scope.getAsync(T), scope.getAsync(T), scope.getAsync(T)]);
    expect(builds).toBe(1);
  });

  it("async factory produces a fresh instance every call", async () => {
    const T = createAsyncToken<number>("aFactory");
    let n = 0;
    const c = new Container();
    c.load(createModule((m) => m.factoryAsync(T, async () => (n += 1))));
    const [a, b] = await Promise.all([c.getAsync(T), c.getAsync(T)]);
    expect(n).toBe(2);
    assertNotSame(a, b);
  });

  it("sync get() of an async provider throws before any side effect", async () => {
    const T = createAsyncToken<number>("aMisuse");
    let started = false;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          started = true;
          return 1;
        }),
      ),
    );
    // The token brand makes this a compile error now; cast to exercise the
    // runtime backstop that still protects untyped/JS callers.
    expect(() => c.get(T as unknown as Token<number>)).toThrowError(AsyncProviderError);
    expect(started, "provider must not start when sync get() is misused").toBe(false);
  });

  it("async provider rejection does not poison the singleton cache", async () => {
    const T = createAsyncToken<string>("aPoison");
    let attempt = 0;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.singleAsync(T, async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("boom");
          return "ok";
        }),
      ),
    );
    try {
      await c.getAsync(T);
    } catch {
      /* expected */
    }
    const value = await c.getAsync(T);
    expect(value).toBe("ok");
    expect(attempt, "a failed resolution must be retryable").toBe(2);
  });
});

function assertNotSame<T>(a: T, b: T): void {
  expect(a !== b, "expected distinct instances").toBeTruthy();
}
