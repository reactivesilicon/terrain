// TOKEN_BRAND is type-only (no runtime value) and unexported, so no code
// outside this module can construct a value satisfying Token/AsyncToken:
// tokens only come from createSyncToken()/createAsyncToken(). `__type` and the
// brand are phantom — declared on the types, never present at runtime.

declare const TOKEN_BRAND: unique symbol;

export const TokenModes = {
  SYNC: "sync",
  ASYNC: "async",
} as const;
export type TokenMode = (typeof TokenModes)[keyof typeof TokenModes];

/** Token for a synchronously-provided value. Resolve with get(). */
export interface Token<T> {
  readonly [TOKEN_BRAND]: true;
  readonly description: string;
  readonly mode: typeof TokenModes.SYNC;
  readonly __type?: T;
}

/** Token for an asynchronously-provided value. Resolve with getAsync(). */
export interface AsyncToken<T> {
  readonly [TOKEN_BRAND]: true;
  readonly description: string;
  readonly mode: typeof TokenModes.ASYNC;
  readonly __type?: T;
}

/** Either kind of token — accepted where resolution mode does not matter. */
export type AnyToken<T> = Token<T> | AsyncToken<T>;

// Debug label only — identity is the object reference, so collisions are harmless.
function randomId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

abstract class BaseToken<T, M extends TokenMode> {
  declare readonly [TOKEN_BRAND]: true;
  declare readonly __type?: T;

  readonly id = randomId();

  // Subclass constructors freeze the instance: freezing here would run before
  // any field a subclass declares is defined, making that field a TypeError.
  protected constructor(
    readonly description: string,
    readonly mode: M,
  ) {}

  toString(): string {
    return `Token<${this.mode} #${this.id}>(${this.description})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  get [Symbol.toStringTag](): string {
    return "Token";
  }
}

class SyncTokenImpl<T> extends BaseToken<T, typeof TokenModes.SYNC> implements Token<T> {
  constructor(description: string) {
    super(description, TokenModes.SYNC);
    Object.freeze(this);
  }
}

class AsyncTokenImpl<T> extends BaseToken<T, typeof TokenModes.ASYNC> implements AsyncToken<T> {
  constructor(description: string) {
    super(description, TokenModes.ASYNC);
    Object.freeze(this);
  }
}

export function createSyncToken<T>(description: string): Token<T> {
  return new SyncTokenImpl(description);
}

export function createAsyncToken<T>(description: string): AsyncToken<T> {
  return new AsyncTokenImpl(description);
}

/** True if the token was created by createAsyncToken. */
export function isAsyncToken(token: AnyToken<any>): token is AsyncToken<any> {
  return token.mode === TokenModes.ASYNC;
}
