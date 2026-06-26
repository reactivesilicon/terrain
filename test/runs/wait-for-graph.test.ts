import { describe, expect, it } from "vitest";

import { WaitForGraph } from "../../src/container/wait-for-graph";
import { createAsyncToken, CircularDependencyError, Lifetimes } from "../internal-api";
import type { ResolutionFrame } from "../internal-api";

// Unit tests for the wait-for graph in isolation. Concurrency tests exercise it
// through the Container; these pin the graph's own contract — cycle detection,
// the named path, counted (duplicate) edges, and teardown — deterministically,
// since those depend on interleavings that are awkward to force through timers.

// A node is a resolution frame; the graph only reads its identity and token, so
// a minimal frame stands in for a real in-flight resolution.
const frame = (name: string): ResolutionFrame => ({
  token: createAsyncToken(name),
  lifetime: Lifetimes.Singleton,
});

describe("WaitForGraph", () => {
  it("records dependency edges and throws a named cycle when an edge would close one", () => {
    const graph = new WaitForGraph();
    const [a, b, c] = [frame("A"), frame("B"), frame("C")];

    graph.recordWaitOrThrow(a, b); // A depends on B
    graph.recordWaitOrThrow(b, c); // B depends on C
    // C depends on A would close A -> B -> C -> A.
    let thrown: unknown;
    try {
      graph.recordWaitOrThrow(c, a);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CircularDependencyError);
    const path = ((thrown as Error).message.split("\n")[1] ?? "").split(" -> ");
    expect(path).toEqual(["C", "A", "B", "C"]);
    expect(path[0], "the cycle closes on the token it started from").toBe(path.at(-1));
  });

  it("does not throw when the dependency edge does not close a cycle", () => {
    const graph = new WaitForGraph();
    const [a, b, c] = [frame("A"), frame("B"), frame("C")];
    graph.recordWaitOrThrow(a, b);
    // C depends on B is a join, not a cycle.
    expect(() => graph.recordWaitOrThrow(c, b)).not.toThrow();
  });

  it("keeps a counted edge alive until every duplicate wait is removed", () => {
    const graph = new WaitForGraph();
    const [a, b, c] = [frame("A"), frame("B"), frame("C")];

    // A depends on B twice (e.g. Promise.all([getAsync(B), getAsync(B)])), B depends on C.
    graph.recordWaitOrThrow(a, b);
    graph.recordWaitOrThrow(a, b);
    graph.recordWaitOrThrow(b, c);

    // One of A's two dependency requests for B settles: the A -> B edge must survive.
    graph.removeWait(a, b);
    expect(() => graph.recordWaitOrThrow(c, a), "A -> B still present, so C -> A closes a cycle").toThrow(
      CircularDependencyError,
    );

    // The second settles: A -> B is gone, so the same wait is now acyclic.
    graph.removeWait(a, b);
    graph.removeWait(b, c);
    expect(() => graph.recordWaitOrThrow(c, a)).not.toThrow();
  });

  it("traverses diamonds without revisiting shared nodes", () => {
    const graph = new WaitForGraph();
    const [a, b, c, d, x] = [frame("A"), frame("B"), frame("C"), frame("D"), frame("X")];
    // Diamond: A -> B -> D and A -> C -> D. A walk from A reaches D by two paths.
    graph.recordWaitOrThrow(a, b);
    graph.recordWaitOrThrow(a, c);
    graph.recordWaitOrThrow(b, d);
    graph.recordWaitOrThrow(c, d);
    // X depends on A: the cycle check walks the whole diamond from A and finds no path
    // back to X, so it must complete (revisiting D once) without throwing.
    expect(() => graph.recordWaitOrThrow(x, a)).not.toThrow();
  });
});
