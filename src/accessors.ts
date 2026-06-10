import type { Container } from "./container/container";
import { type AnyToken, type AsyncToken, isAsyncToken, type Token } from "./token";

/** Name → token mapping a accessors is built from. */
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

/**
 * Builds named accessors over a container so call sites need no tokens:
 * createAccessors(c, { db: DbToken }) gives accessors.db() instead of c.get(DbToken).
 *
 * Accessors are lazy — each call resolves through the container, honoring the
 * definition's lifetime. The spec's tokens need not be loaded until the first
 * call, and a disposed container makes every accessor throw.
 */
export function createAccessors<S extends AccessorSpec>(container: Container, spec: S): Accessors<S> {
  const accessors: Record<string, () => unknown> = {};
  for (const [name, token] of Object.entries(spec)) {
    accessors[name] = isAsyncToken(token) ? () => container.getAsync(token) : () => container.get(token);
  }
  return Object.freeze(accessors) as Accessors<S>;
}
