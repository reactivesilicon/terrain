import { DuplicateEntryNameError, InvalidEntryNameError } from "../errors";
import type { TokenMode } from "../token";
import type { Lifetime, SingletonDefinitionOptions } from "../types";
import { isIdentifierName } from "../validations/name-validations";

export type ModuleEntryProvider = (resolverNamespaces: object) => unknown;

export interface ModuleEntryDefinition {
  localName: string;
  lifetime: Lifetime;
  mode: TokenMode;
  provider: ModuleEntryProvider;
  options: SingletonDefinitionOptions<unknown> | undefined;
}

export class ModuleEntryDefinitions {
  readonly #definitionsByLocalName = new Map<string, ModuleEntryDefinition>();
  readonly #moduleName: string;

  constructor(moduleName: string) {
    this.#moduleName = moduleName;
  }

  register(definition: ModuleEntryDefinition): void {
    if (!isIdentifierName(definition.localName)) {
      throw new InvalidEntryNameError(definition.localName, this.#moduleName);
    }

    if (this.#definitionsByLocalName.has(definition.localName)) {
      throw new DuplicateEntryNameError(definition.localName, this.#moduleName);
    }

    this.#definitionsByLocalName.set(definition.localName, definition);
  }

  registeredDefinitions(): IterableIterator<ModuleEntryDefinition> {
    return this.#definitionsByLocalName.values();
  }
}
