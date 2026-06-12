import { describe, expect, it } from "vitest";

import { Container, createAsyncToken, createModule, createSyncToken, Lifetimes } from "../../src";
import { DuplicateDefinitionError, InvalidDefinitionError, ModuleOwnershipError } from "../../src";

describe("modules", () => {
  it("multiple modules compose", () => {
    const Logger = createSyncToken<(m: string) => void>("mLogger");
    const Mailer = createSyncToken<{ send(to: string): string }>("mMailer");
    const infra = createModule((m) => m.single(Logger, () => () => {}));
    const feature = createModule((m) =>
      m.single(Mailer, (r) => ({
        send: (to: string) => {
          r.get(Logger)(`-> ${to}`);
          return `sent:${to}`;
        },
      })),
    );
    const c = new Container();
    c.load(infra);
    c.load(feature);
    expect(c.get(Mailer).send("x")).toBe("sent:x");
  });

  it("duplicate token within a single module throws at build time", () => {
    const T = createSyncToken<number>("mDup");
    let threw = false;
    try {
      createModule((m) => {
        m.single(T, () => 1);
        m.single(T, () => 2);
      });
    } catch (e) {
      threw = e instanceof DuplicateDefinitionError;
    }
    expect(threw).toBeTruthy();
  });

  it("Module does not expose a mutable definitions map", () => {
    const T = createSyncToken<number>("mImm");
    const mod = createModule((m) => m.single(T, () => 1)) as unknown as Record<string, unknown>;
    expect(mod.definitions, "internal map must not be exposed").toBe(undefined);
    expect(typeof mod.entries).toBe("function");
    expect(typeof mod.keys).toBe("function");
  });

  it("Definition objects are frozen", () => {
    const T = createSyncToken<number>("mFrozen");
    const mod = createModule((m) => m.single(T, () => 1));
    let mutated = true;
    for (const [, def] of mod.entries()) {
      try {
        (def as { async: boolean }).async = true;
        mutated = (def as { async: boolean }).async === true;
      } catch {
        mutated = false;
      }
    }
    expect(mutated, "definitions must be frozen").toBe(false);
  });

  it("override across loads works after a clean reload", async () => {
    const T = createSyncToken<string>("mReload");
    const v1 = createModule((m) => m.single(T, () => "v1"));
    const v2 = createModule((m) => m.single(T, () => "v2"));
    const c = new Container();
    c.load(v1);
    expect(c.get(T)).toBe("v1");
    await c.unload(v1);
    c.load(v2);
    expect(c.get(T)).toBe("v2");
  });

  it("unload then reload from a different container is fine", () => {
    const T = createSyncToken<number>("mIndep");
    const mod = createModule((m) => m.single(T, () => 1));
    const a = new Container();
    const b = new Container();
    a.load(mod);
    b.load(mod);
    expect(a.get(T)).toBe(1);
    expect(b.get(T)).toBe(1);
    expect(a.get(T) === 1 && b.get(T) === 1).toBeTruthy();
  });

  it("a stale module cannot unload its replacement after an override", async () => {
    const T = createSyncToken<number>("ownStale");
    const v1 = createModule((m) => m.single(T, () => 1));
    const v2 = createModule((m) => m.single(T, () => 2));
    const c = new Container();
    c.load(v1);
    c.load(v2, { override: true });
    await expect(c.unload(v1)).rejects.toThrowError(ModuleOwnershipError);
    expect(c.get(T), "the replacement's wiring is untouched").toBe(2);
    await c.unload(v2); // the current owner can unload
  });

  it("a stale module cannot unload after unload+reload of its tokens", async () => {
    const T = createSyncToken<number>("ownReload");
    const v1 = createModule((m) => m.single(T, () => 1));
    const v2 = createModule((m) => m.single(T, () => 2));
    const c = new Container();
    c.load(v1);
    await c.unload(v1);
    c.load(v2);
    await expect(c.unload(v1)).rejects.toThrowError(ModuleOwnershipError);
    expect(c.get(T)).toBe(2);
  });

  it("loading the same module twice without override throws", async () => {
    const T = createSyncToken<number>("mTwice");
    const mod = createModule((m) => m.single(T, () => 1));
    const c = new Container();
    c.load(mod);
    expect(() => c.load(mod)).toThrowError(DuplicateDefinitionError);
  });

  it("define() registers data-driven definitions the container resolves normally", async () => {
    const S = createSyncToken<string>("defSync");
    const A = createAsyncToken<number>("defAsync");
    const mod = createModule((m) => {
      m.define({ token: S, lifetime: Lifetimes.Singleton, async: false, provider: () => "via define" });
      m.define({ token: A, lifetime: Lifetimes.Factory, async: true, provider: async () => 7 });
    });
    const c = new Container();
    c.load(mod);
    expect(c.get(S)).toBe("via define");
    await expect(c.getAsync(A)).resolves.toBe(7);
  });

  it("define() rejects an eager non-singleton at runtime (and the type forbids it)", () => {
    const T = createSyncToken<number>("defEager");
    const smuggled = { token: T, lifetime: Lifetimes.Factory, async: false, provider: () => 1, eager: true } as const;
    expect(() =>
      createModule((m) => {
        // @ts-expect-error -- eager is unwritable on non-singleton definitions
        m.define(smuggled);
      }),
    ).toThrowError(InvalidDefinitionError);
  });

  it("define() rejects a duplicate token like the sugar methods do", () => {
    const T = createSyncToken<number>("defDup");
    expect(() =>
      createModule((m) => {
        m.define({ token: T, lifetime: Lifetimes.Singleton, async: false, provider: () => 1 });
        m.define({ token: T, lifetime: Lifetimes.Singleton, async: false, provider: () => 2 });
      }),
    ).toThrowError(DuplicateDefinitionError);
  });

  it("define() copies the record: mutating it afterwards does not affect the module", () => {
    const T = createSyncToken<number>("defCopy");
    const record = { token: T, lifetime: Lifetimes.Singleton, async: false as const, provider: () => 1 };
    const mod = createModule((m) => m.define(record));
    record.provider = () => 2;
    const c = new Container();
    c.load(mod);
    expect(c.get(T)).toBe(1);
  });
});
