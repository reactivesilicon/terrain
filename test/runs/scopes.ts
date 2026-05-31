import { Container, createModule, createToken } from "../../src";
import { DisposedContainerError } from "../../src";
import { suite, assert, assertEqual, assertThrows, isInstance } from "../harness";

suite("scopes", (test) => {
  test("createScope inherits parent definitions", () => {
    const T = createToken<number>("inh");
    const root = new Container();
    root.load(createModule((m) => m.single(T, () => 5)));
    assertEqual(root.createScope().get(T), 5);
  });

  test("withScope returns the body result", async () => {
    const root = new Container();
    const result = await root.withScope(async () => 42);
    assertEqual(result, 42);
  });

  test("withScope disposes its scope afterwards", async () => {
    const T = createToken<{ dispose(): void }>("ws");
    let disposed = 0;
    const root = new Container();
    root.load(createModule((m) => m.scoped(T, () => ({ dispose: () => disposed++ }))));
    await root.withScope(async (scope) => {
      scope.get(T);
    });
    assertEqual(disposed, 1);
  });

  test("withScope preserves the body error when disposal succeeds", async () => {
    const root = new Container();
    const bodyErr = new Error("body");
    await assertThrows(
      () =>
        root.withScope(async () => {
          throw bodyErr;
        }),
      (e) => e === bodyErr,
    );
  });

  test("withScope aggregates body + disposal errors (flattened)", async () => {
    const T = createToken<{ dispose(): void }>("wsAgg");
    const root = new Container();
    root.load(
      createModule((m) =>
        m.scoped(T, () => ({
          dispose: () => {
            throw new Error("dispose-failed");
          },
        })),
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
    assert(caught instanceof AggregateError, "expected AggregateError");
    assert(leaves.includes(bodyErr), "body error must be preserved");
    assert(
      leaves.some((x) => x instanceof Error && x.message === "dispose-failed"),
      "dispose error must be preserved",
    );
    assert(
      leaves.every((x) => !(x instanceof AggregateError)),
      "aggregate must be flattened",
    );
  });

  test("createScope throws when an ancestor is disposed", async () => {
    const root = new Container();
    const child = root.createScope();
    await root.dispose();
    await assertThrows(() => child.createScope(), isInstance(DisposedContainerError));
  });
});
