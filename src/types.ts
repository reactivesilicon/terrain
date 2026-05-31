import type {Token} from "./token"

export const Lifetimes = {
  Singleton: "singleton",
  Factory: "factory",
  Scoped: "scoped",
} as const
export type Lifetime = typeof Lifetimes[keyof typeof Lifetimes]

/** Resolver handed to synchronous providers — no getAsync. */
export interface SyncResolver {
  get<T>(token: Token<T>): T
  has<T>(token: Token<T>): boolean
}

/** Resolver handed to async providers. */
export interface AsyncResolver extends SyncResolver {
  getAsync<T>(token: Token<T>): Promise<T>
}

export type SyncProvider<T> = (resolver: SyncResolver) => T
export type AsyncProvider<T> = (resolver: AsyncResolver) => Promise<T>
export type Provider<T> = SyncProvider<T> | AsyncProvider<T>

/** Immutable once built (frozen by Module). */
type BaseDefinition<T> = Readonly<{
  token: Token<T>
  lifetime: Lifetime
}>

export type SyncDefinition<T> = BaseDefinition<T> & Readonly<{
  async: false
  provider: SyncProvider<T>
}>

export type AsyncDefinition<T> = BaseDefinition<T> & Readonly<{
  async: true
  provider: AsyncProvider<T>
}>

export type Definition<T> = SyncDefinition<T> | AsyncDefinition<T>

export interface Disposable {
  dispose(): void | Promise<void>
}

export interface LoadOptions {
  /** Replace an existing definition in THIS container. Rejected if the token
   *  is already in use (cached/in-flight anywhere in the subtree). */
  override?: boolean
}

export interface ContainerOptions {
  /** Observe disposal errors for ORPHANED in-flight instances only — i.e. a
   *  resolution that completed after dispose()/unload() had already evicted its
   *  token, so its result can't be cached and is disposed immediately.
   *  Disposal failures during normal dispose()/unload() are NOT reported here;
   *  they surface via the AggregateError those methods throw. */
  onDisposeError?: (error: unknown) => void
}