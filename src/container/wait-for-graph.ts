import { CircularDependencyError } from "../errors";
import type { ResolutionFrame } from "../types";
import { tokenName } from "../utils";

/** Thin host surface; implementations delegate to the tree root's WaitForGraph. */
export interface WaitForGraphHost {
  recordWaitOrThrow(waiter: ResolutionFrame, target: ResolutionFrame): void;
  removeWait(waiter: ResolutionFrame, target: ResolutionFrame): void;
}

interface WaitNode {
  /** get(targetFrame) -> recorded in-flight dependency edge count.
   *  Counted rather than a set because one provider can request the same
   *  dependency more than once, and each request is torn down independently. */
  dependencyCountsByTargetFrame: Map<ResolutionFrame, number>;
  /** Incoming dependency edge count, including duplicate requests. */
  incomingWaitCount: number;
}

/**
 * Cross-call dependency graph over in-flight cached async resolutions; lives on
 * the container-tree root. A node is a resolution's frame — a fresh object
 * created (by `Container.extend`) BEFORE the provider runs, so it is a stable
 * identity even mid-synchronous-descent. The frame carries its token, so cycle
 * messages need no separate labels.
 *
 * CONTRACT — in-flight provider dependency tracking, NOT await observation.
 * Within an async provider, every `resolver.getAsync(T)` call declares that the
 * resolution under construction depends on T — whether the returned promise is
 * awaited, returned, or ignored. The engine cannot observe (and does not try to
 * infer) whether you actually await the result, so it treats `getAsync` as
 * dependency acquisition. A cycle among these declared dependencies is reported
 * as `CircularDependencyError`.
 *
 * This is deliberately conservative: a fire-and-forget `void getAsync(X)`, or a
 * `Promise.race` over resolutions, inside a provider that forms a cycle is
 * reported as circular even if it would not actually deadlock at runtime. That
 * is intentional — a DI container reasons about the dependency graph, not
 * JavaScript await timing. (See STATUS.md.)
 *
 * Why a graph and not just the per-chain check: `Container.checkCircular...`
 * only sees a cycle within ONE resolution chain. A coalesce joins another
 * descent's in-flight resolution without extending the chain, and a cycle can
 * mix descents (builds) with coalesces — only the full graph sees those. So
 * every cached async dependency is recorded: a build edge (ancestor → the
 * resolution it is constructing) and a coalesce edge (the running resolution →
 * the in-flight peer it joins). An edge is dropped when its target resolution
 * settles, after which nothing can still be blocked on its in-flight
 * construction (dependents may still use the resolved value — the edge is only
 * about in-flight cycle detection).
 *
 * A cycle-closing edge is always refused, so the graph stays a DAG and
 * `findWaitPath` always terminates.
 */
export class WaitForGraph {
  private waitNodesByFrame = new Map<ResolutionFrame, WaitNode>();

  /** Record that `waiter` depends on `target`. Throws `CircularDependencyError`
   *  if `target` already (transitively) depends on `waiter` (the edge would
   *  close a cycle), leaving the graph unchanged in that case. */
  recordWaitOrThrow(waiter: ResolutionFrame, target: ResolutionFrame): void {
    const cycle = this.findWaitPath(target, waiter);
    if (cycle) {
      // `cycle` is [target, …, waiter]; the refused edge would close it as
      // waiter -> target -> … -> waiter, which is the order the message reads.
      throw new CircularDependencyError([waiter, ...cycle].map((frame) => tokenName(frame.token)));
    }
    const waiterNode = this.getOrCreateWaitNode(waiter);
    waiterNode.dependencyCountsByTargetFrame.set(
      target,
      (waiterNode.dependencyCountsByTargetFrame.get(target) ?? 0) + 1,
    );
    this.getOrCreateWaitNode(target).incomingWaitCount += 1;
  }

  /** Drop one `waiter -> target` dependency edge once `target`'s resolution has
   *  settled (nothing can be blocked on its in-flight construction any longer). */
  removeWait(waiter: ResolutionFrame, target: ResolutionFrame): void {
    const waiterNode = this.waitNodesByFrame.get(waiter);
    const dependencyCount = waiterNode?.dependencyCountsByTargetFrame.get(target);
    /* v8 ignore next -- unreachable: removeWait fires once per recorded edge, so
       the edge it tears down is always still present. */
    if (!waiterNode || dependencyCount === undefined) return;
    if (dependencyCount > 1) waiterNode.dependencyCountsByTargetFrame.set(target, dependencyCount - 1);
    else waiterNode.dependencyCountsByTargetFrame.delete(target);
    this.pruneIfIsolated(waiter, waiterNode);

    const targetNode = this.waitNodesByFrame.get(target);
    /* v8 ignore next -- unreachable: a recorded edge always created the target
       node and bumped its counter, so it is present until this removal. */
    if (!targetNode) return;
    targetNode.incomingWaitCount -= 1;
    this.pruneIfIsolated(target, targetNode);
  }

  private getOrCreateWaitNode(frame: ResolutionFrame): WaitNode {
    let node = this.waitNodesByFrame.get(frame);
    if (!node) {
      node = { dependencyCountsByTargetFrame: new Map(), incomingWaitCount: 0 };
      this.waitNodesByFrame.set(frame, node);
    }
    return node;
  }

  // An isolated node (no edges either way) holds no state and is recreated on
  // demand by getOrCreateWaitNode if it gains an edge again, so dropping it is
  // safe and keeps the map bounded to live edges.
  private pruneIfIsolated(frame: ResolutionFrame, node: WaitNode): void {
    if (node.dependencyCountsByTargetFrame.size === 0 && node.incomingWaitCount === 0)
      this.waitNodesByFrame.delete(frame);
  }

  // The graph is a DAG (a cycle-closing edge is always refused), so this DFS
  // terminates; `discovered` only avoids re-walking shared nodes across diamonds.
  private findWaitPath(sourceFrame: ResolutionFrame, targetFrame: ResolutionFrame): ResolutionFrame[] | undefined {
    const discovered = new Set<ResolutionFrame>();
    const walk = (currentFrame: ResolutionFrame): ResolutionFrame[] | undefined => {
      if (currentFrame === targetFrame) return [currentFrame];
      if (discovered.has(currentFrame)) return undefined;
      discovered.add(currentFrame);
      const waitNode = this.waitNodesByFrame.get(currentFrame);
      if (!waitNode) return undefined;
      for (const waitedForFrame of waitNode.dependencyCountsByTargetFrame.keys()) {
        const restOfPath = walk(waitedForFrame);
        if (restOfPath) return [currentFrame, ...restOfPath];
      }
      return undefined;
    };
    return walk(sourceFrame);
  }
}
