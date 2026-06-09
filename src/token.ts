// Object tokens. A token is a small immutable object: unique by reference
// identity (collision-safe like a symbol), carrying its debug name and its
// resolution mode as real runtime fields. The concrete classes are not
// exported and the brand symbol cannot be produced outside this module, so
// tokens can only come from createToken()/createAsyncToken() — a structural
// look-alike object does not typecheck.
//
// `__type` is phantom: never present at runtime, only used by the type system
// so get(token) infers T. `mode` is both the type-level discriminant (it makes
// Token and AsyncToken mutually inassignable, so resolving an async token with
// get() is a compile-time error) and the runtime answer to "which kind?" for
// mode-dispatching code (isAsyncToken).

declare const TOKEN_BRAND: unique symbol;

/** Token for a synchronously-provided value. Resolve with get(). */
export interface Token<T> {
  readonly [TOKEN_BRAND]: true;
  readonly description: string;
  readonly mode: "sync";
  readonly __type?: T;
}

/** Token for an asynchronously-provided value. Resolve with getAsync(). */
export interface AsyncToken<T> {
  readonly [TOKEN_BRAND]: true;
  readonly description: string;
  readonly mode: "async";
  readonly __type?: T;
}

/** Either kind of token — accepted where resolution mode does not matter
 *  (has(), unload bookkeeping, error reporting). */
export type AnyToken<T> = Token<T> | AsyncToken<T>;

class SyncTokenImpl<T> implements Token<T> {
  // Brand is phantom: declared on the type, asserted here, never read at runtime.
  declare readonly [TOKEN_BRAND]: true;
  declare readonly __type?: T;
  readonly mode = "sync" as const;

  constructor(readonly description: string) {
    Object.freeze(this);
  }

  toString(): string {
    return `Token(${this.description})`;
  }
}

class AsyncTokenImpl<T> implements AsyncToken<T> {
  declare readonly [TOKEN_BRAND]: true;
  declare readonly __type?: T;
  readonly mode = "async" as const;

  constructor(readonly description: string) {
    Object.freeze(this);
  }

  toString(): string {
    return `AsyncToken(${this.description})`;
  }
}

export function createToken<T>(description: string): Token<T> {
  return new SyncTokenImpl(description);
}

export function createAsyncToken<T>(description: string): AsyncToken<T> {
  return new AsyncTokenImpl(description);
}

/** True if the token resolves asynchronously (was created by createAsyncToken). */
export function isAsyncToken(token: AnyToken<any>): token is AsyncToken<any> {
  return token.mode === "async";
}
