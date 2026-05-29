import type { AsyncProvider, Definition, Lifetime, SyncProvider } from "./types"
import type { Token } from "./token"
import { DuplicateDefinitionError } from "./errors"

function tokenName(token: symbol): string {
  return token.description || "UnknownToken"
}

// Non-exported brand: prevents a plain object literal from satisfying Module
// structurally. Modules can only come from createModule()/ModuleBuilder.
declare const MODULE_BRAND: unique symbol

/** Public, read-only view of a module. The concrete class is not exported, and
 *  the brand cannot be produced outside this module, so there is no ordinary
 *  construction path that bypasses builder validation. */
export interface Module {
  readonly [MODULE_BRAND]: true
  entries(): IterableIterator<[Token<any>, Definition<any>]>
  keys(): IterableIterator<Token<any>>
}

class BuiltModule implements Module {
  // Brand is phantom: declared on the type, asserted here, never read at runtime.
  declare readonly [MODULE_BRAND]: true

  private readonly _definitions: ReadonlyMap<Token<any>, Definition<any>>

  constructor(definitions: ReadonlyMap<Token<any>, Definition<any>>) {
    this._definitions = new Map(
      [...definitions].map(([token, definition]) => [token, Object.freeze({ ...definition })]),
    )
  }

  entries(): IterableIterator<[Token<any>, Definition<any>]> {
    return this._definitions.entries()
  }

  keys(): IterableIterator<Token<any>> {
    return this._definitions.keys()
  }
}

export class ModuleBuilder {
  private readonly definitions = new Map<Token<any>, Definition<any>>()

  private add<T>(
    token: Token<T>,
    lifetime: Lifetime,
    provider: SyncProvider<T> | AsyncProvider<T>,
    async: boolean,
  ): void {
    if (this.definitions.has(token)) {
      throw new DuplicateDefinitionError(tokenName(token))
    }
    this.definitions.set(token, { token, lifetime, provider, async })
  }

  single<T>(token: Token<T>, provider: SyncProvider<T>): void {
    this.add(token, "singleton", provider, false)
  }
  singleAsync<T>(token: Token<T>, provider: AsyncProvider<T>): void {
    this.add(token, "singleton", provider, true)
  }
  factory<T>(token: Token<T>, provider: SyncProvider<T>): void {
    this.add(token, "factory", provider, false)
  }
  factoryAsync<T>(token: Token<T>, provider: AsyncProvider<T>): void {
    this.add(token, "factory", provider, true)
  }
  scoped<T>(token: Token<T>, provider: SyncProvider<T>): void {
    this.add(token, "scoped", provider, false)
  }
  scopedAsync<T>(token: Token<T>, provider: AsyncProvider<T>): void {
    this.add(token, "scoped", provider, true)
  }

  build(): Module {
    return new BuiltModule(this.definitions)
  }
}

export function createModule(setup: (builder: ModuleBuilder) => void): Module {
  const builder = new ModuleBuilder()
  setup(builder)
  return builder.build()
}