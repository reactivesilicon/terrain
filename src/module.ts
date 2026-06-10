import { DuplicateDefinitionError } from "./errors";
import type { AnyToken, AsyncToken, Token } from "./token";
import {
  type AsyncDefinition,
  type AsyncProvider,
  type Definition,
  type DefinitionOptions,
  type Lifetime,
  Lifetimes,
  type SyncDefinition,
  type SyncProvider,
} from "./types";
import { tokenName } from "./utils";

// Non-exported brand: prevents a plain object literal from satisfying Module
// structurally. Modules can only come from createModule()/ModuleBuilder.
declare const MODULE_BRAND: unique symbol;

/** Public, read-only view of a module. The concrete class is not exported, and
 *  the brand cannot be produced outside this module, so there is no ordinary
 *  construction path that bypasses builder validation. */
export interface Module {
  readonly [MODULE_BRAND]: true;
  entries(): IterableIterator<[AnyToken<any>, Definition<any>]>;
  keys(): IterableIterator<AnyToken<any>>;
}

class BuiltModule implements Module {
  // Brand is phantom: declared on the type, asserted here, never read at runtime.
  declare readonly [MODULE_BRAND]: true;

  private readonly _definitions: ReadonlyMap<AnyToken<any>, Definition<any>>;

  constructor(definitions: ReadonlyMap<AnyToken<any>, Definition<any>>) {
    this._definitions = new Map(
      [...definitions].map(([token, definition]) => [token, Object.freeze({ ...definition })]),
    );
  }

  entries(): IterableIterator<[AnyToken<any>, Definition<any>]> {
    return this._definitions.entries();
  }

  keys(): IterableIterator<AnyToken<any>> {
    return this._definitions.keys();
  }
}

export class ModuleBuilder {
  private readonly definitions = new Map<AnyToken<any>, Definition<any>>();

  private add<T>(token: Token<T>, lifetime: Lifetime, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    if (this.definitions.has(token)) {
      throw new DuplicateDefinitionError(tokenName(token));
    }
    const definition: SyncDefinition<T> = {
      token,
      lifetime,
      provider,
      async: false,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    };
    this.definitions.set(token, definition);
  }

  private addAsync<T>(
    token: AsyncToken<T>,
    lifetime: Lifetime,
    provider: AsyncProvider<T>,
    options?: DefinitionOptions<T>,
  ): void {
    if (this.definitions.has(token)) {
      throw new DuplicateDefinitionError(tokenName(token));
    }
    const definition: AsyncDefinition<T> = {
      token,
      lifetime,
      provider,
      async: true,
      ...(options?.dispose ? { dispose: options.dispose } : {}),
    };
    this.definitions.set(token, definition);
  }

  single<T>(token: Token<T>, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.add(token, Lifetimes.Singleton, provider, options);
  }
  singleAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.addAsync(token, Lifetimes.Singleton, provider, options);
  }
  factory<T>(token: Token<T>, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.add(token, Lifetimes.Factory, provider, options);
  }
  factoryAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.addAsync(token, Lifetimes.Factory, provider, options);
  }
  scoped<T>(token: Token<T>, provider: SyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.add(token, Lifetimes.Scoped, provider, options);
  }
  scopedAsync<T>(token: AsyncToken<T>, provider: AsyncProvider<T>, options?: DefinitionOptions<T>): void {
    this.addAsync(token, Lifetimes.Scoped, provider, options);
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
