import { DuplicateDefinitionError, InvalidDefinitionError } from "./errors";
import type { AnyToken, AsyncToken, Token } from "./token";
import {
  type AsyncProvider,
  type Definition,
  type DefinitionOptions,
  type SingletonDefinitionOptions,
  Lifetimes,
  type SyncProvider,
} from "./types";
import { tokenName } from "./utils";

declare const MODULE_BRAND: unique symbol;

/** Public, read-only view of a module. The concrete class is not exported and
 *  the brand cannot be produced outside this file, so a structural look-alike
 *  does not typecheck: modules only come from createModule()/ModuleBuilder. */
export interface Module {
  readonly [MODULE_BRAND]: true;
  entries(): IterableIterator<[AnyToken<any>, Definition<any>]>;
  keys(): IterableIterator<AnyToken<any>>;
}

class BuiltModule implements Module {
  // Brand is phantom: declared on the type, asserted here, never read at runtime.
  declare readonly [MODULE_BRAND]: true;

  // An ECMAScript private field, not TS `private`: the map must not exist as
  // a runtime property at all (TS visibility erases at runtime).
  readonly #definitions: ReadonlyMap<AnyToken<any>, Definition<any>>;

  constructor(definitions: ReadonlyMap<AnyToken<any>, Definition<any>>) {
    this.#definitions = new Map([...definitions].map(([token, definition]) => [token, Object.freeze(definition)]));
  }

  entries(): IterableIterator<[AnyToken<any>, Definition<any>]> {
    return this.#definitions.entries();
  }

  keys(): IterableIterator<AnyToken<any>> {
    return this.#definitions.keys();
  }
}

export class ModuleBuilder {
  private readonly definitions = new Map<AnyToken<any>, Definition<any>>();

  define<T>(definition: Definition<T>): void {
    if (definition.eager && definition.lifetime !== Lifetimes.Singleton) {
      throw new InvalidDefinitionError(JSON.stringify(definition));
    }
    if (this.definitions.has(definition.token)) {
      throw new DuplicateDefinitionError(tokenName(definition.token));
    }
    this.definitions.set(definition.token, definition);
  }

  single<T>(token: Token<T>, provider: SyncProvider<T>, options?: SingletonDefinitionOptions<T>): void {
    this.define({
      token: token,
      lifetime: Lifetimes.Singleton,
      async: false,
      provider: provider,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
      ...(options?.eager ? { eager: true } : {}),
    });
  }

  singleAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: SingletonDefinitionOptions<T>): void {
    this.define({
      token: token,
      lifetime: Lifetimes.Singleton,
      async: true,
      provider: provider,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
      ...(options?.eager ? { eager: true } : {}),
    });
  }

  factory<T>(token: Token<T>, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.define({
      token: token,
      lifetime: Lifetimes.Factory,
      async: false,
      provider: provider,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    });
  }

  factoryAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.define({
      token: token,
      lifetime: Lifetimes.Factory,
      async: true,
      provider: provider,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    });
  }

  scoped<T>(token: Token<T>, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.define({
      token: token,
      lifetime: Lifetimes.Scoped,
      async: false,
      provider: provider,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    });
  }

  scopedAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.define({
      token: token,
      lifetime: Lifetimes.Scoped,
      async: true,
      provider: provider,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    });
  }

  build(): Module {
    return new BuiltModule(this.definitions);
  }
}

export function createModule(setup: (builder: ModuleBuilder) => void): Module {
  const builder = new ModuleBuilder();
  setup(builder);
  return builder.build();
}
