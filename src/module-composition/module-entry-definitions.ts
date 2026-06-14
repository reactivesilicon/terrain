import { DuplicateEntryNameError, InvalidEntryNameError } from "../errors";
import type { TokenMode } from "../token";
import type { Lifetime, SingletonDefinitionOptions } from "../types";
import { isIdentifierName } from "../validations/name-validations";

export type ModuleEntryName = string;

export type ModuleEntryProvider = (resolverNamespaces: object) => unknown;

export interface ModuleEntryDefinition {
  entryName: ModuleEntryName;
  lifetime: Lifetime;
  mode: TokenMode;
  provider: ModuleEntryProvider;
  options: SingletonDefinitionOptions<unknown> | undefined;
}

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
