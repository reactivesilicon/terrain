// Branded-symbol tokens. Kept for v0.1 because they are simple, collision-safe,
// and carry a debug name through Symbol.description. NOTE: switching to
// object tokens later would be a BREAKING API change for callers (all existing
// tokens are symbols) unless a compatibility bridge is added.
//
// `__type` and `__mode` are phantom: never present at runtime, only used by
// the type system. `__mode` makes Token and AsyncToken mutually inassignable,
// so resolving an async token with get() (or registering it with a sync
// builder method) is a compile-time error, not just the runtime
// AsyncProviderError/SyncProviderError backstop.

/** Token for a synchronously-provided value. Resolve with get(). */
export type Token<T> = symbol & { readonly __type?: T; readonly __mode?: "sync" };

/** Token for an asynchronously-provided value. Resolve with getAsync(). */
export type AsyncToken<T> = symbol & { readonly __type?: T; readonly __mode?: "async" };

/** Either kind of token — accepted where resolution mode does not matter
 *  (has(), unload bookkeeping, error reporting). */
export type AnyToken<T> = Token<T> | AsyncToken<T>;

export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}

export function createAsyncToken<T>(description: string): AsyncToken<T> {
  return Symbol(description) as AsyncToken<T>;
}
