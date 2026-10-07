import { InvalidEntryNameError, InvalidModuleNameError, InvalidModuleUseError } from "../errors";
import { RESERVED_ENTRY_NAMES, RESERVED_MODULE_NAMES } from "./reserved-names";

export { RESERVED_ENTRY_NAMES, RESERVED_MODULE_NAMES };
export type { ReservedEntryName, ReservedModuleName } from "./reserved-names";

const IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED_MODULE_NAME_SET: ReadonlySet<string> = new Set(RESERVED_MODULE_NAMES);
const RESERVED_ENTRY_NAME_SET: ReadonlySet<string> = new Set(RESERVED_ENTRY_NAMES);

function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name);
}

export function assertModuleName(name: string): void {
  if (!isIdentifierName(name) || RESERVED_MODULE_NAME_SET.has(name)) {
    throw new InvalidModuleNameError(name);
  }
}

export function assertEntryName(entryName: string, moduleName: string): void {
  if (!isIdentifierName(entryName) || RESERVED_ENTRY_NAME_SET.has(entryName)) {
    throw new InvalidEntryNameError(entryName, moduleName);
  }
}

/** Resolver namespaces are keyed by module name: a module's own name and the
 *  names of everything it uses must be pairwise distinct, or one namespace
 *  would silently shadow another. */
export function assertNoNamespaceCollisions(moduleName: string, uses: readonly { readonly name: string }[]): void {
  const seenNames = new Set<string>();
  for (const used of uses) {
    if (used.name === moduleName) {
      throw new InvalidModuleUseError(`Module '${moduleName}' cannot use a module bearing its own name.`);
    }
    if (seenNames.has(used.name)) {
      throw new InvalidModuleUseError(`Duplicate used module name '${used.name}' in module '${moduleName}'.`);
    }
    seenNames.add(used.name);
  }
}
