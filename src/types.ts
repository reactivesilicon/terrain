import type { AnyToken, AsyncToken, Token } from "./token";

export const Lifetimes = {
  Singleton: "singleton",
  Factory: "factory",
  Scoped: "scoped",
} as const;
export type Lifetime = (typeof Lifetimes)[keyof typeof Lifetimes];
export type NonSingletonLifetime = Exclude<Lifetime, typeof Lifetimes.Singleton>;

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

/** Teardown registered with a definition. May be async even for a sync
 *  entry: disposal always runs in an async context. */
export type Disposer<T> = (instance: T) => void | Promise<void>;

/** Options for single/singleAsync. */
export interface SingletonDefinitionOptions<T> {
  /** Called with the instance when its container is disposed. Without it the
   *  container never touches the instance at teardown: there is no dispose()
   *  duck-typing. */
  dispose?: Disposer<T>;
  /** Construct this instance during start() instead of on first resolution,
   *  for connections and similar work that must finish at boot. Only
   *  singletons can be eager: a factory caches nothing, and a scoped entry has
   *  no scope to construct into at boot. */
  eager?: boolean;
}

/** Options for scoped/scopedAsync. */
export interface ScopedDefinitionOptions<T> {
  /** Called with the instance when the scope (or container) holding it is
   *  disposed. Without it the container never touches the instance at
   *  teardown: there is no dispose() duck-typing. */
  dispose?: Disposer<T>;
}

/** Options for factory/factoryAsync. A factory's instances belong to the
 *  caller: the container never disposes an instance it handed out. */
export interface FactoryDefinitionOptions<T> {
  /** Called only for an instance nobody claimed: one that finished building
   *  after its container started disposing, so it was never handed out. */
  disposeUnclaimed?: Disposer<T>;
}

type LifetimeOptions =
  | { lifetime: typeof Lifetimes.Singleton; eager?: boolean }
  | { lifetime: NonSingletonLifetime; eager?: never };

/** Immutable once built (frozen by Module). */
export type SyncDefinition<T> = Readonly<
  {
    token: Token<T>;
    async: false;
    provider: SyncProvider<T>;
    dispose?: Disposer<T>;
  } & LifetimeOptions
>;

export type AsyncDefinition<T> = Readonly<
  {
    token: AsyncToken<T>;
    async: true;
    provider: AsyncProvider<T>;
    dispose?: Disposer<T>;
  } & LifetimeOptions
>;

// On a factory definition, `dispose` covers only unclaimed instances: the
// container keeps no others.
export type Definition<T> = SyncDefinition<T> | AsyncDefinition<T>;

export interface LoadOptions {
  /** Replace an existing definition in THIS container. Rejected if the token
   *  is already in use (cached/in-flight anywhere in the subtree). */
  override?: boolean;
}

export interface ContainerOptions {
  /** Observe disposal errors that no caller can receive:
   *  - unclaimed instances: one that finished building after its container
   *    started disposing, so it was never handed out and is disposed at once;
   *  - a disposal started by dispose() called from inside a disposer, which
   *    returns without waiting (it can't wait on its own teardown).
   *  Without this hook, those failures are printed with console.error.
   *  Disposal failures during a normal dispose() are NOT reported here;
   *  they surface via the AggregateError it throws. */
  onDisposeError?: (error: unknown) => void;
}

export interface ResolutionFrame {
  token: AnyToken<any>;
  lifetime: Lifetime;
}
