import { Container, createModule, createSyncToken } from "../../src";
import { DuplicateDefinitionError } from "../../src";
import { suite, assert, assertEqual, assertThrows, isInstance } from "../harness";

suite("modules", (test) => {
  test("multiple modules compose", () => {
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
    assertEqual(c.get(Mailer).send("x"), "sent:x");
  });

  test("duplicate token within a single module throws at build time", () => {
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
    assert(threw);
  });

  test("Module does not expose a mutable definitions map", () => {
    const T = createSyncToken<number>("mImm");
    const mod = createModule((m) => m.single(T, () => 1)) as unknown as Record<string, unknown>;
    assertEqual(mod.definitions, undefined, "internal map must not be exposed");
    assertEqual(typeof mod.entries, "function");
    assertEqual(typeof mod.keys, "function");
  });

  test("Definition objects are frozen", () => {
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
    assertEqual(mutated, false, "definitions must be frozen");
  });

  test("override across loads works after a clean reload", async () => {
    const T = createSyncToken<string>("mReload");
    const v1 = createModule((m) => m.single(T, () => "v1"));
    const v2 = createModule((m) => m.single(T, () => "v2"));
    const c = new Container();
    c.load(v1);
    assertEqual(c.get(T), "v1");
    await c.unload(v1);
    c.load(v2);
    assertEqual(c.get(T), "v2");
  });

  test("unload then reload from a different container is fine", () => {
    const T = createSyncToken<number>("mIndep");
    const mod = createModule((m) => m.single(T, () => 1));
    const a = new Container();
    const b = new Container();
    a.load(mod);
    b.load(mod);
    assertEqual(a.get(T), 1);
    assertEqual(b.get(T), 1);
    assert(a.get(T) === 1 && b.get(T) === 1);
  });

  test("loading the same module twice without override throws", async () => {
    const T = createSyncToken<number>("mTwice");
    const mod = createModule((m) => m.single(T, () => 1));
    const c = new Container();
    c.load(mod);
    await assertThrows(() => c.load(mod), isInstance(DuplicateDefinitionError));
  });
});
