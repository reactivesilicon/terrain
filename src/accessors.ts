import type { Container } from "./container/container";
import { type AnyToken, type AsyncToken, isAsyncToken, type Token } from "./token";
import type { AsyncResolver, SyncResolver } from "./types";

/** Name → token mapping accessors are built from. */
export type AccessorSpec = Record<string, AnyToken<any>>;

/** Typed accessors derived from a spec: sync tokens become () => T,
 *  async tokens become () => Promise<T>. */
export type Accessors<S extends AccessorSpec> = {
  readonly [K in keyof S]: S[K] extends AsyncToken<infer T>
    ? () => Promise<T>
    : S[K] extends Token<infer T>
      ? () => T
      : never;
};

interface AccessorInstance {
  readonly source: SyncResolver;
  readonly accessorCache: Record<string, (() => unknown) | undefined>;
}

/** One prototype per spec, instantiated once per source. Entries are lazy
 *  getters: the first access creates and caches a closure bound to the
 *  instance's source, so instances are O(1) to create, only accessors actually
 *  used are allocated, and destructured accessors keep working (the closure
 *  captures the instance, not `this`). */
export function buildAccessorPrototype(spec: AccessorSpec): object {
  const prototype = {};
  for (const [name, token] of Object.entries(spec)) {
    // A prototype must only be instantiated over a source that can resolve
    // every token in its spec: a spec with async tokens needs an AsyncResolver
    // (or Container); a sync-only spec works over a plain SyncResolver.
    const resolve = isAsyncToken(token)
      ? (source: SyncResolver) => (source as AsyncResolver).getAsync(token)
      : (source: SyncResolver) => source.get(token);
    Object.defineProperty(prototype, name, {
      enumerable: true,
      get(this: AccessorInstance) {
        const cached = this.accessorCache[name];
        if (cached) return cached;
        const source = this.source;
        const accessor = () => resolve(source);
        this.accessorCache[name] = accessor;
        return accessor;
      },
    });
  }
  return Object.freeze(prototype);
}

export function instantiateAccessors(prototype: object, source: SyncResolver): object {
  const accessors = Object.create(prototype) as AccessorInstance;
  Object.defineProperties(accessors, {
    source: { value: source },
    accessorCache: { value: {} },
  });
  return Object.freeze(accessors);
}

/**
 * Builds named accessors over a container so call sites need no tokens:
 * createAccessors(c, { db: DbToken }) gives accessors.db() instead of c.get(DbToken).
 * Also available as container.accessors(spec).
 *
 * Accessors are lazy — each call resolves through the container, honoring the
 * definition's lifetime. The spec's tokens need not be loaded until the first
 * call, and a disposed container makes every accessor throw.
 */
export function createAccessors<S extends AccessorSpec>(container: Container, spec: S): Accessors<S> {
  return instantiateAccessors(buildAccessorPrototype(spec), container) as Accessors<S>;
}
