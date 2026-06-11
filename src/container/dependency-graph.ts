import type { AnyToken } from "../token";
import { Lifetimes, type ResolutionFrame } from "../types";

type EdgeMap = Map<AnyToken<any>, Set<AnyToken<any>>>;

/** Token-level "who captured whom" edges for one container tree (lives on the
 *  root). Recorded at construction time; unload() consults it to refuse
 *  evicting tokens that live instances still depend on. */
export class DependencyGraph {
  private dependenciesByDependent: EdgeMap = new Map(); // get(B) -> what B depends on
  private dependentsByDependency: EdgeMap = new Map(); // get(A) -> who depends on A

  recordResolvedDependency(dependency: AnyToken<any>, chain: ResolutionFrame[]): void {
    const dependentUnderConstruction = DependencyGraph.nearestCachedFrame(chain)?.token;
    // No cached frame: the caller itself holds the result. External references
    // cannot be tracked — the documented limit of unload safety.
    if (!dependentUnderConstruction) return;
    DependencyGraph.addEdge(this.dependenciesByDependent, dependentUnderConstruction, dependency);
    DependencyGraph.addEdge(this.dependentsByDependency, dependency, dependentUnderConstruction);
  }

  /** Dependents outside the unload set whose live instances would be left
   *  holding an evicted dependency. */
  collectLiveDependents(
    unloadSet: ReadonlySet<AnyToken<any>>,
    hasLiveInstance: (token: AnyToken<any>) => boolean,
  ): AnyToken<any>[] {
    return this.collectTransitiveDependents(unloadSet).filter(hasLiveInstance);
  }

  private collectTransitiveDependents(tokens: ReadonlySet<AnyToken<any>>): AnyToken<any>[] {
    const discovered = new Set<AnyToken<any>>();
    const dependenciesToVisit: AnyToken<any>[] = [...tokens];

    while (dependenciesToVisit.length > 0) {
      const dependency = dependenciesToVisit.pop()!;
      for (const dependent of this.dependentsByDependency.get(dependency) ?? []) {
        if (tokens.has(dependent) || discovered.has(dependent)) continue;
        discovered.add(dependent);
        dependenciesToVisit.push(dependent);
      }
    }
    return [...discovered];
  }

  // Dropping both directions is safe: a reloaded definition records fresh
  // edges when it constructs.
  purge(token: AnyToken<any>): void {
    for (const dependency of this.dependenciesByDependent.get(token) ?? []) {
      DependencyGraph.removeEdge(this.dependentsByDependency, dependency, token);
    }
    for (const dependent of this.dependentsByDependency.get(token) ?? []) {
      DependencyGraph.removeEdge(this.dependenciesByDependent, dependent, token);
    }
    this.dependenciesByDependent.delete(token);
    this.dependentsByDependency.delete(token);
  }

  // Factory frames pass through: "singleton -> factory -> X" attributes the
  // capture of X to the singleton, whose instance is what outlives the call.
  private static nearestCachedFrame(chain: ResolutionFrame[]): ResolutionFrame | undefined {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const frame = chain[i]!;
      if (frame.lifetime !== Lifetimes.Factory) return frame;
    }
    return undefined;
  }

  private static addEdge(edges: EdgeMap, source: AnyToken<any>, target: AnyToken<any>): void {
    let targets = edges.get(source);
    if (!targets) {
      targets = new Set();
      edges.set(source, targets);
    }
    targets.add(target);
  }

  private static removeEdge(edges: EdgeMap, source: AnyToken<any>, target: AnyToken<any>): void {
    const targets = edges.get(source);
    /* v8 ignore next -- unreachable: edges are always added pairwise, so the
       inverse set exists whenever purge finds a forward entry. */
    if (!targets) return;
    targets.delete(target);
    if (targets.size === 0) edges.delete(source);
  }
}
