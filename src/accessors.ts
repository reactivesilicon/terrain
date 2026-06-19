import type { Container } from "./container/container";
import { type AnyToken, type AsyncToken, isAsyncToken, type Token } from "./token";
import type { AsyncResolver, SyncResolver } from "./types";

/** Name → token mapping accessors are built from. */
export type AccessorSpec = Record<string, AnyToken<unknown>>;
/** A sync-only spec: every token resolves through a plain SyncResolver. */
export type SyncAccessorSpec = Record<string, Token<unknown>>;

/** Typed accessors derived from a spec: sync tokens become () => T,
 *  async tokens become () => Promise<T>. */
export type Accessors<S extends AccessorSpec> = {
  readonly [K in keyof S]: S[K] extends AsyncToken<infer T>
    ? () => Promise<T>
    : S[K] extends Token<infer T>
      ? () => T
      : never;
};

declare const REQUIRED_SOURCE: unique symbol;

interface AccessorInstance<Source extends SyncResolver> {
  readonly source: Source;
  readonly accessorCache: Record<string, (() => unknown) | undefined>;
}

/** Built once per spec: the lazy getters live here, frozen. The Source type
 *  param is the weakest resolver it can be instantiated over — a sync-only
 *  prototype works over any resolver; a full one requires getAsync. */
export class AccessorPrototype<Source extends SyncResolver> {
  // Source must be branded by a function-typed PROPERTY, not the instantiate()
  // method param: method params are checked bivariantly, so the param alone
  // would let a getAsync-needing prototype be instantiated over a plain
  // SyncResolver. This contravariant property is what actually rejects that.
  declare readonly [REQUIRED_SOURCE]?: (source: Source) => void;

  constructor(resolversByName: Record<string, (source: Source) => unknown>) {
    for (const [name, resolve] of Object.entries(resolversByName)) {
      Object.defineProperty(this, name, {
        enumerable: true,
        get(this: AccessorInstance<Source>) {
          const cached = this.accessorCache[name];
          if (cached) return cached;
          const source = this.source;
          const accessor = () => resolve(source);
          this.accessorCache[name] = accessor;
          return accessor;
        },
      });
    }
    Object.freeze(this);
  }

  /** O(1): a lightweight per-source instance inheriting these getters. */
  instantiate(source: Source): object {
    const instance = Object.create(this) as AccessorInstance<Source>;
    Object.defineProperties(instance, {
      source: { value: source },
      accessorCache: { value: {} },
    });
    return Object.freeze(instance);
  }
}

export function buildSyncAccessorPrototype(spec: SyncAccessorSpec): AccessorPrototype<SyncResolver> {
  const resolversByName: Record<string, (source: SyncResolver) => unknown> = {};
  for (const [name, token] of Object.entries(spec)) resolversByName[name] = (source) => source.get(token);
  return new AccessorPrototype(resolversByName);
}

export function buildAccessorPrototype(spec: AccessorSpec): AccessorPrototype<AsyncResolver> {
  const resolversByName: Record<string, (source: AsyncResolver) => unknown> = {};
  for (const [name, token] of Object.entries(spec)) {
    resolversByName[name] = isAsyncToken(token) ? (source) => source.getAsync(token) : (source) => source.get(token);
  }
  return new AccessorPrototype(resolversByName);
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
  return buildAccessorPrototype(spec).instantiate(container) as Accessors<S>;
}
