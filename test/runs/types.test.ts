import { describe, expectTypeOf, it } from "vitest";

import { createContainer, createModule, type ContainerConfig, type ContainerOptions } from "../../src";

// Positive type-contract assertions. These are no-ops at runtime; their
// enforcement path is `bun run typecheck:test` (tsc -p tsconfig.test.json),
// NOT `vitest run`. A wrong assertion surfaces only as a tsc error. Every
// accessor-return assertion is paired with `.not.toBeAny()` because the whole
// point is to catch an `any`-leak through the composition builder's casts —
// an `any` silently satisfies every existing `@ts-expect-error` test.

interface Logger {
  info(message: string): void;
}
interface UserRepo {
  find(id: string): string | null;
}

describe("public type contract (positive assertions)", () => {
  it("container accessors have exact sync/async return types — no any-leak", () => {
    const Infra = createModule("Infra", (m) =>
      m.single("logger", (): Logger => ({ info() {} })).singleAsync("config", async () => ({ env: "prod" as const })),
    );
    const app = createContainer({ parts: [Infra] });

    expectTypeOf(app.Infra.logger).toEqualTypeOf<() => Logger>();
    expectTypeOf(app.Infra.logger()).toEqualTypeOf<Logger>();
    expectTypeOf(app.Infra.logger()).not.toBeAny();

    expectTypeOf(app.Infra.config).toEqualTypeOf<() => Promise<{ env: "prod" }>>();
    expectTypeOf(app.Infra.config()).resolves.toEqualTypeOf<{ env: "prod" }>();
    expectTypeOf(app.Infra.config()).not.toBeAny();
  });

  it("provider resolver namespaces carry imported + own-earlier entry types", () => {
    const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => ({ info() {} })));
    createModule("Data", { uses: [Infra] }, (m) =>
      m
        .single("rows", () => new Map<string, string>([["1", "Ada"]]))
        .single("userRepo", (r): UserRepo => {
          // imported module entry, exact type
          expectTypeOf(r.Infra.logger()).toEqualTypeOf<Logger>();
          expectTypeOf(r.Infra.logger()).not.toBeAny();
          // own earlier entry, exact type
          expectTypeOf(r.Data.rows()).toEqualTypeOf<Map<string, string>>();
          expectTypeOf(r.Data.rows()).not.toBeAny();
          return { find: (id) => r.Data.rows().get(id) ?? null };
        }),
    );
  });

  it("the container view exposes namespaces plus lifecycle methods", () => {
    const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => ({ info() {} })));
    const app = createContainer({ parts: [Infra] });

    expectTypeOf(app.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();
    expectTypeOf(app.start).toEqualTypeOf<() => Promise<void>>();
    expectTypeOf(app.dispose).toEqualTypeOf<() => Promise<void>>();
    expectTypeOf(app.scope).toBeFunction();
  });

  it("createContainer accepts a config object and infers namespaces from parts", () => {
    const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => ({ info() {} })));

    const a = createContainer({ parts: [Infra] });
    expectTypeOf(a.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();

    const options: ContainerOptions = { onDisposeError() {} };
    const b = createContainer({ options: options, parts: [Infra] });
    expectTypeOf(b.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();

    const config: ContainerConfig<readonly [typeof Infra]> = { parts: [Infra] };
    const c = createContainer({ ...config });
    expectTypeOf(c.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();

    void function compileOnly() {
      const compose = createContainer;
      // @ts-expect-error parts is required
      createContainer({});
      // @ts-expect-error unknown option key is rejected
      createContainer({ options: { nope: true }, parts: [Infra] });
      // @ts-expect-error the variadic form was removed
      compose(Infra);
    };
  });

  it("override .with/.withAsync infer the original entry's value type", () => {
    const Infra = createModule("Infra", (m) =>
      m.single("logger", (): Logger => ({ info() {} })).singleAsync("config", async () => ({ env: "prod" as const })),
    );
    Infra.override((o) =>
      o.with("logger", (): Logger => ({ info() {} })).withAsync("config", async () => ({ env: "prod" as const })),
    );
    // The provider return types above must satisfy the original entry types;
    // a wrong return type here would be a tsc error caught by typecheck:test.
    expectTypeOf(Infra.override).toBeFunction();
  });

  it("module names: valid identifiers accepted, invalid literal names rejected", () => {
    const infra = createModule("infra", (m) => m.single("logger", (): Logger => ({ info() {} })));
    const data2 = createModule("data2", (m) => m.single("logger", (): Logger => ({ info() {} })));
    const $data = createModule("$data", (m) => m.single("logger", (): Logger => ({ info() {} })));
    const _data = createModule("_data", (m) => m.single("logger", (): Logger => ({ info() {} })));
    const app = createContainer({ parts: [infra, data2, $data, _data] });

    expectTypeOf(app.infra.logger()).toEqualTypeOf<Logger>();
    expectTypeOf(app.infra.logger()).not.toBeAny();
    expectTypeOf(app.data2.logger()).toEqualTypeOf<Logger>();
    expectTypeOf(app.data2.logger()).not.toBeAny();
    expectTypeOf(app.$data.logger()).toEqualTypeOf<Logger>();
    expectTypeOf(app.$data.logger()).not.toBeAny();
    expectTypeOf(app._data.logger()).toEqualTypeOf<Logger>();
    expectTypeOf(app._data.logger()).not.toBeAny();

    void function compileOnly() {
      // @ts-expect-error 'dispose' is a reserved view-method name
      createModule("dispose", (m) => m.single("x", () => 1));
      // @ts-expect-error spaces are not valid module identifiers
      createModule("data 2", (m) => m.single("x", () => 1));
      // @ts-expect-error module names cannot start with a digit
      createModule("2data", (m) => m.single("x", () => 1));
      // @ts-expect-error hyphen is not valid in module identifiers
      createModule("data-name", (m) => m.single("x", () => 1));
      // @ts-expect-error dot is not valid in module identifiers
      createModule("data.name", (m) => m.single("x", () => 1));
      // @ts-expect-error empty string is not a valid module identifier
      createModule("", (m) => m.single("x", () => 1));
    };
  });
});
