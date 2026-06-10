import type { AnyToken, AsyncToken, Token } from "./token";

export const Lifetimes = {
  Singleton: "singleton",
  Factory: "factory",
  Scoped: "scoped",
} as const;
export type Lifetime = (typeof Lifetimes)[keyof typeof Lifetimes];

/** Resolver handed to synchronous providers — no getAsync. Within a resolver,
 *  has(t) implies t is resolvable from it, so only sync tokens are accepted. */
export interface SyncResolver {
  get<T>(token: Token<T>): T;
  has<T>(token: Token<T>): boolean;
}

/** Resolver handed to async providers. Both token kinds are actionable here,
 *  so has() re-widens to AnyToken. */
export interface AsyncResolver extends SyncResolver {
  getAsync<T>(token: AsyncToken<T>): Promise<T>;
  has<T>(token: AnyToken<T>): boolean;
}

export type SyncProvider<T> = (resolver: SyncResolver) => T;
export type AsyncProvider<T> = (resolver: AsyncResolver) => Promise<T>;
export type Provider<T> = SyncProvider<T> | AsyncProvider<T>;

/** Teardown registered with a definition. May be async even for sync tokens —
 *  disposal always runs in an async context (dispose/unload/withScope). */
export type Disposer<T> = (instance: T) => void | Promise<void>;

/** Per-definition registration options. */
export interface DefinitionOptions<T> {
  /** Called with the instance when its container/scope is disposed or its
   *  module unloaded (cached lifetimes), or when an in-flight result is
   *  orphaned by teardown. Without it the container never touches the
   *  instance at teardown — there is no dispose() duck-typing. */
  dispose?: Disposer<T>;
}

/** Immutable once built (frozen by Module). */
export type SyncDefinition<T> = Readonly<{
  token: Token<T>;
  lifetime: Lifetime;
  async: false;
  provider: SyncProvider<T>;
  dispose?: Disposer<T>;
}>;

export type AsyncDefinition<T> = Readonly<{
  token: AsyncToken<T>;
  lifetime: Lifetime;
  async: true;
  provider: AsyncProvider<T>;
  dispose?: Disposer<T>;
}>;

export type Definition<T> = SyncDefinition<T> | AsyncDefinition<T>;

export interface LoadOptions {
  /** Replace an existing definition in THIS container. Rejected if the token
   *  is already in use (cached/in-flight anywhere in the subtree). */
  override?: boolean;
}

export interface ContainerOptions {
  /** Observe disposal errors for ORPHANED in-flight instances only — i.e. a
   *  resolution that completed after dispose()/unload() had already evicted its
   *  token, so its result can't be cached and is disposed immediately.
   *  Disposal failures during normal dispose()/unload() are NOT reported here;
   *  they surface via the AggregateError those methods throw. */
  onDisposeError?: (error: unknown) => void;
}

export interface ResolutionFrame {
  token: AnyToken<any>;
  lifetime: Lifetime;
}
