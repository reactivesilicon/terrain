import { describe, expect, it } from "vitest";

import { Container, createModule, createSyncToken } from "../../src";

describe("resolution", () => {
  it("providers receive a resolver and can pull dependencies", () => {
    const A = createSyncToken<{ tag: string }>("A");
    const B = createSyncToken<{ a: { tag: string } }>("B");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, () => ({ tag: "a" }));
        m.single(B, (r) => ({ a: r.get(A) }));
      }),
    );
    expect(c.get(B).a.tag).toBe("a");
  });

  it("deep dependency chain resolves", () => {
    const A = createSyncToken<{ n: number }>("dA");
    const B = createSyncToken<{ n: number }>("dB");
    const D = createSyncToken<{ n: number }>("dC");
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(A, () => ({ n: 1 }));
        m.single(B, (r) => ({ n: r.get(A).n + 1 }));
        m.single(D, (r) => ({ n: r.get(B).n + 1 }));
      }),
    );
    expect(c.get(D).n).toBe(3);
  });

  it("child resolves an ancestor-defined token", () => {
    const T = createSyncToken<number>("anc");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => 9)));
    expect(root.createScope().get(T)).toBe(9);
  });

  it("root singleton is shared across child scopes", () => {
    const T = createSyncToken<object>("rootSingle");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => ({}))));
    const a = root.createScope();
    const b = root.createScope();
    expect(a.get(T) === b.get(T)).toBeTruthy();
  });

  it("sibling scopes with their own definitions are isolated", () => {
    const T = createSyncToken<number>("sib");
    const root = new Container();
    const a = root.createScope();
    const b = root.createScope();
    a.load(createModule((m) => m.single(T, () => 1)));
    b.load(createModule((m) => m.single(T, () => 2)));
    expect(a.get(T)).toBe(1);
    expect(b.get(T)).toBe(2);
  });

  it("sync provider's resolver does not expose getAsync at runtime", () => {
    const T = createSyncToken<number>("noAsync");
    let hadGetAsync = true;
    const c = new Container();
    c.load(
      createModule((m) =>
        m.single(T, (r) => {
          hadGetAsync = "getAsync" in (r as object);
          return 1;
        }),
      ),
    );
    c.get(T);
    expect(hadGetAsync, "SyncResolver must not carry getAsync").toBe(false);
  });

  it("has() reflects presence", () => {
    const T = createSyncToken<number>("present");
    const U = createSyncToken<number>("absent");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => 1)));
    expect(c.has(T)).toBe(true);
    expect(c.has(U)).toBe(false);
  });

  it("inject() is lazy and honors lifetime", () => {
    const S = createSyncToken<object>("lazyS");
    const F = createSyncToken<object>("lazyF");
    let built = 0;
    const c = new Container();
    c.load(
      createModule((m) => {
        m.single(S, () => {
          built += 1;
          return {};
        });
        m.factory(F, () => ({}));
      }),
    );
    const getS = c.inject(S);
    expect(built, "inject must not resolve until called").toBe(0);
    expect(getS() === getS(), "inject(singleton) returns the shared instance").toBeTruthy();
    expect(built).toBe(1);
    const getF = c.inject(F);
    expect(getF() !== getF(), "inject(factory) returns fresh instances").toBeTruthy();
  });
});
