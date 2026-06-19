import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { MissingDependencyError } from "../../src";
import { Container, createAsyncToken, createModule, createSyncToken } from "../../src/internal";

describe("tokens", () => {
  it("toString carries mode, debug id, and description", () => {
    expect(String(createSyncToken<number>("db"))).toMatch(/^Token<sync #\w{6}>\(db\)$/);
    expect(String(createAsyncToken<number>("cfg"))).toMatch(/^Token<async #\w{6}>\(cfg\)$/);
  });

  it("two same-description tokens print distinguishably", () => {
    const first = createSyncToken<number>("dup");
    const second = createSyncToken<number>("dup");
    expect(String(first)).not.toBe(String(second));
  });

  it("JSON.stringify embeds the readable form", () => {
    const token = createSyncToken<number>("json");
    expect(JSON.stringify({ token })).toBe(`{"token":"${String(token)}"}`);
  });

  it("node's inspect uses the custom formatter", () => {
    const token = createSyncToken<number>("inspected");
    expect(inspect(token)).toBe(String(token));
  });

  it("Object.prototype.toString reports [object Token]", () => {
    expect(Object.prototype.toString.call(createSyncToken<number>("tagged"))).toBe("[object Token]");
  });

  it("an empty description falls back to UnknownToken in error messages", () => {
    const unnamed = createSyncToken<number>("");
    const c = new Container();
    const failure = (() => {
      try {
        c.get(unnamed);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(failure).toBeInstanceOf(MissingDependencyError);
    expect(failure?.message).toContain("UnknownToken");
  });

  it("tokens are frozen", () => {
    expect(Object.isFrozen(createSyncToken<number>("frozen"))).toBe(true);
    expect(Object.isFrozen(createAsyncToken<number>("frozenAsync"))).toBe(true);
  });

  it("a module can register a frozen-token definition", () => {
    const T = createSyncToken<number>("frozenReg");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    expect(c.get(T)).toBe(1);
  });
});
