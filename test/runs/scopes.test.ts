import { describe, expect, it } from "vitest";

import { Container, createModule, createSyncToken } from "../../src/internal";
import { DisposedContainerError } from "../../src/internal";

describe("scopes", () => {
  it("createScope inherits parent definitions", () => {
    const T = createSyncToken<number>("inh");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => 5)));
    expect(root.createScope().get(T)).toBe(5);
  });

  it("withScope returns the body result", async () => {
    const root = new Container();
    const result = await root.withScope(async () => 42);
    expect(result).toBe(42);
  });

  it("withScope disposes its scope afterwards", async () => {
    const T = createSyncToken<{ dispose(): void }>("ws");
    let disposed = 0;
    const root = new Container();
    root.load(
      createModule((m) => m.scoped(T, () => ({ dispose: () => (disposed += 1) }), { dispose: (x) => x.dispose() })),
    );
    await root.withScope(async (scope) => {
      scope.get(T);
    });
    expect(disposed).toBe(1);
  });

  it("withScope preserves the body error when disposal succeeds", async () => {
    const root = new Container();
    const bodyErr = new Error("body");
    await expect(
      root.withScope(async () => {
        throw bodyErr;
      }),
    ).rejects.toBe(bodyErr);
  });

  it("withScope rethrows the disposal failure when the body succeeded", async () => {
    const T = createSyncToken<object>("wsDispFail");
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(T, () => ({}), {
          dispose: () => {
            throw new Error("teardown-fail");
          },
        }),
      ),
    );
    const failure = await root
      .withScope(async (scope) => {
        scope.get(T);
        return "body-ok";
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.some((e) => e instanceof Error && e.message === "teardown-fail")).toBe(
      true,
    );
  });

  it("withScope aggregates body + disposal errors (flattened)", async () => {
    const T = createSyncToken<{ dispose(): void }>("wsAgg");
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(
          T,
          () => ({
            dispose: () => {
              throw new Error("dispose-failed");
            },
          }),
          { dispose: (x) => x.dispose() },
        ),
      ),
    );
    const bodyErr = new Error("body-failed");
    let caught: unknown;
    try {
      await root.withScope(async (scope) => {
        scope.get(T);
        throw bodyErr;
      });
    } catch (e) {
      caught = e;
    }
    const flatten = (e: unknown): unknown[] => (e instanceof AggregateError ? e.errors.flatMap(flatten) : [e]);
    const leaves = flatten(caught);
    expect(caught instanceof AggregateError, "expected AggregateError").toBeTruthy();
    expect(leaves.includes(bodyErr), "body error must be preserved").toBeTruthy();
    expect(
      leaves.some((x) => x instanceof Error && x.message === "dispose-failed"),
      "dispose error must be preserved",
    ).toBeTruthy();
    expect(
      leaves.every((x) => !(x instanceof AggregateError)),
      "aggregate must be flattened",
    ).toBeTruthy();
  });

  it("createScope throws when an ancestor is disposed", async () => {
    const root = new Container();
    const child = root.createScope();
    await root.dispose();
    expect(() => child.createScope()).toThrowError(DisposedContainerError);
  });
});
