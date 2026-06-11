import { DuplicateDefinitionError } from "./errors";
import type { AnyToken, AsyncToken, Token } from "./token";
import {
  type AsyncDefinition,
  type AsyncProvider,
  type Definition,
  type DefinitionOptions,
  type SingletonDefinitionOptions,
  type Lifetime,
  Lifetimes,
  type SyncDefinition,
  type SyncProvider,
} from "./types";
import { tokenName } from "./utils";

type NonSingletonLifetime = Exclude<Lifetime, typeof Lifetimes.Singleton>;

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
    this.#definitions = new Map(
      [...definitions].map(([token, definition]) => [token, Object.freeze({ ...definition })]),
    );
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

  private assertNewToken(token: AnyToken<any>): void {
    if (this.definitions.has(token)) {
      throw new DuplicateDefinitionError(tokenName(token));
    }
  }

  // Singleton registration is the only path that reads `eager`; the
  // addNonSingleton path cannot carry it even if a caller smuggles the option
  // past the (literal-only) excess-property check.
  private addSingleton<T>(token: Token<T>, provider: SyncProvider<T>, options?: SingletonDefinitionOptions<T>): void {
    this.assertNewToken(token);
    const definition: SyncDefinition<T> = {
      token: token,
      lifetime: Lifetimes.Singleton,
      provider: provider,
      async: false,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
      ...(options?.eager ? { eager: true } : {}),
    };
    this.definitions.set(token, definition);
  }

  private addSingletonAsync<T>(
    token: AsyncToken<T>,
    provider: AsyncProvider<T>,
    options?: SingletonDefinitionOptions<T>,
  ): void {
    this.assertNewToken(token);
    const definition: AsyncDefinition<T> = {
      token: token,
      lifetime: Lifetimes.Singleton,
      provider: provider,
      async: true,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
      ...(options?.eager ? { eager: true } : {}),
    };
    this.definitions.set(token, definition);
  }

  private addNonSingleton<T>(
    token: Token<T>,
    lifetime: NonSingletonLifetime,
    provider: SyncProvider<T>,
    options?: DefinitionOptions<T>,
  ): void {
    this.assertNewToken(token);
    const definition: SyncDefinition<T> = {
      token: token,
      lifetime: lifetime,
      provider: provider,
      async: false,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    };
    this.definitions.set(token, definition);
  }

  private addNonSingletonAsync<T>(
    token: AsyncToken<T>,
    lifetime: NonSingletonLifetime,
    provider: AsyncProvider<T>,
    options?: DefinitionOptions<T>,
  ): void {
    this.assertNewToken(token);
    const definition: AsyncDefinition<T> = {
      token: token,
      lifetime: lifetime,
      provider: provider,
      async: true,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    };
    this.definitions.set(token, definition);
  }

  single<T>(token: Token<T>, provider: SyncProvider<T>, options?: SingletonDefinitionOptions<T>): void {
    this.addSingleton(token, provider, options);
  }
  singleAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: SingletonDefinitionOptions<T>): void {
    this.addSingletonAsync(token, provider, options);
  }
  factory<T>(token: Token<T>, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.addNonSingleton(token, Lifetimes.Factory, provider, options);
  }
  factoryAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.addNonSingletonAsync(token, Lifetimes.Factory, provider, options);
  }
  scoped<T>(token: Token<T>, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.addNonSingleton(token, Lifetimes.Scoped, provider, options);
  }
  scopedAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.addNonSingletonAsync(token, Lifetimes.Scoped, provider, options);
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
