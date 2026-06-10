import { Container, createModule, createSyncToken } from "../../src";
import { suite, assert, assertEqual } from "../harness";

suite("lifetimes", (test) => {
  test("singleton returns the same instance", () => {
    const T = createSyncToken<object>("single");
    const c = new Container();
    c.load(createModule((m) => m.single(T, () => ({}))));
    assert(c.get(T) === c.get(T), "singleton must be shared");
  });

  test("factory returns a new instance each call", () => {
    const T = createSyncToken<object>("factory");
    const c = new Container();
    c.load(createModule((m) => m.factory(T, () => ({}))));
    assert(c.get(T) !== c.get(T), "factory must produce fresh instances");
  });

  test("scoped returns the same instance within one scope", () => {
    const T = createSyncToken<object>("scoped");
    const root = new Container();
    root.load(createModule((m) => m.scoped(T, () => ({}))));
    const scope = root.createScope();
    assert(scope.get(T) === scope.get(T), "scoped must be stable within a scope");
  });

  test("scoped returns different instances across scopes", () => {
    const T = createSyncToken<object>("scoped2");
    const root = new Container();
    root.load(createModule((m) => m.scoped(T, () => ({}))));
    assert(root.createScope().get(T) !== root.createScope().get(T));
  });

  test("typed token resolves without casting", () => {
    interface Svc {
      value(): number;
    }
    const Svc = createSyncToken<Svc>("typed");
    const c = new Container();
    c.load(createModule((m) => m.single(Svc, () => ({ value: () => 7 }))));
    assertEqual(c.get(Svc).value(), 7);
  });
});
