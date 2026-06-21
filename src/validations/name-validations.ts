import { InvalidModuleNameError } from "../errors";
import { RESERVED_MODULE_NAMES } from "./reserved-module-names";

export { RESERVED_MODULE_NAMES };
export type { ReservedModuleName } from "./reserved-module-names";

const IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const RESERVED_MODULE_NAME_SET: ReadonlySet<string> = new Set(RESERVED_MODULE_NAMES);

export function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name);
}

export function assertModuleName(name: string): void {
  if (!isIdentifierName(name) || RESERVED_MODULE_NAME_SET.has(name)) {
    throw new InvalidModuleNameError(name);
  }
}
