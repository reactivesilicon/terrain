import { DuplicateEntryNameError, InvalidEntryNameError } from "../errors";
import type { Simplify } from "../kernel/types";
import { type AsyncToken, createAsyncToken, createSyncToken, type Token, TokenModes } from "../token";
import type { Lifetime, SingletonDefinitionOptions } from "../types";
import { isIdentifierName } from "../validations/name-validations";

export type ModuleEntryName = string;

export type SyncModuleEntryProvider = (resolverNamespaces: object) => unknown;
export type AsyncModuleEntryProvider = (resolverNamespaces: object) => Promise<unknown>;
export type ModuleEntryProvider = SyncModuleEntryProvider | AsyncModuleEntryProvider;

type BaseModuleEntryDefinition = {
  entryName: ModuleEntryName;
  lifetime: Lifetime;
  options: SingletonDefinitionOptions<unknown> | undefined;
};

// TODO: find better name
type SyncProvision = { mode: typeof TokenModes.Sync; provider: SyncModuleEntryProvider };
type AsyncProvision = { mode: typeof TokenModes.Async; provider: AsyncModuleEntryProvider };

export type ModuleEntryDefinition =
  | Simplify<BaseModuleEntryDefinition & SyncProvision>
  | Simplify<BaseModuleEntryDefinition & AsyncProvision>;

export type ModuleEntryDefinitionWithToken =
  | Simplify<BaseModuleEntryDefinition & SyncProvision & { token: Token<unknown> }>
  | Simplify<BaseModuleEntryDefinition & AsyncProvision & { token: AsyncToken<unknown> }>;

export class ModuleEntryDefinitions {
  readonly #definitionsByEntryName = new Map<ModuleEntryName, ModuleEntryDefinition>();
  readonly #moduleName: string;

  constructor(moduleName: string) {
    this.#moduleName = moduleName;
  }

  register(definition: ModuleEntryDefinition): void {
    if (!isIdentifierName(definition.entryName)) {
      throw new InvalidEntryNameError(definition.entryName, this.#moduleName);
    }

    if (this.#definitionsByEntryName.has(definition.entryName)) {
      throw new DuplicateEntryNameError(definition.entryName, this.#moduleName);
    }

    this.#definitionsByEntryName.set(definition.entryName, definition);
  }

  registeredDefinitions(): IterableIterator<ModuleEntryDefinition> {
    return this.#definitionsByEntryName.values();
  }
}

export function bundleModuleEntryDefinitionWithToken(
  moduleName: string,
  entryDefinition: ModuleEntryDefinition,
): ModuleEntryDefinitionWithToken {
  const tokenDescription = `${moduleName}.${entryDefinition.entryName}`;
  switch (entryDefinition.mode) {
    case TokenModes.Sync:
      return { ...entryDefinition, token: createSyncToken<unknown>(tokenDescription) };
    case TokenModes.Async:
      return { ...entryDefinition, token: createAsyncToken<unknown>(tokenDescription) };

    /* v8 ignore next -- unreachable: ModuleEntryDefinition.mode is exhausted by TokenModes.Sync and TokenModes.Async. */
    default:
      throw new Error(`Invalid token mode for entry ${entryDefinition} in module ${moduleName}`);
  }
}
