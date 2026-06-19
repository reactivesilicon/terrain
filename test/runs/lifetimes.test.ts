import { describe, expect, it } from "vitest";

import { Container, createModule, createSyncToken } from "../internal-api";

describe("lifetimes", () => {
  it("singleton returns the same instance", () => {
    const T = createSyncToken<object>("single");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => ({}))));
    expect(c.get(T) === c.get(T), "singleton must be shared").toBeTruthy();
  });

  it("factory returns a new instance each call", () => {
    const T = createSyncToken<object>("factory");
    const c = new Container();
    c.load(createModule((m) => m.factory(T, () => ({}))));
    expect(c.get(T) !== c.get(T), "factory must produce fresh instances").toBeTruthy();
  });

  it("scoped returns the same instance within one scope", () => {
    const T = createSyncToken<object>("scoped");
    const root = new Container();
    root.load(createModule((m) => m.scoped(T, () => ({}))));
    const scope = root.createScope();
    expect(scope.get(T) === scope.get(T), "scoped must be stable within a scope").toBeTruthy();
  });

  it("scoped returns different instances across scopes", () => {
    const T = createSyncToken<object>("scoped2");
    const root = new Container();
    root.load(createModule((m) => m.scoped(T, () => ({}))));
    expect(root.createScope().get(T) !== root.createScope().get(T)).toBeTruthy();
  });

  it("typed token resolves without casting", () => {
    interface Svc {
      value(): number;
    }
    const Svc = createSyncToken<Svc>("typed");
    const c = new Container();
    c.load(createModule((m) => m.single(Svc, () => ({ value: () => 7 }))));
    expect(c.get(Svc).value()).toBe(7);
  });
});
