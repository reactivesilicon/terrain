import { InvalidModuleNameError } from "../errors";

const PASCAL_CASE_IDENTIFIER = /^[A-Z][A-Za-z0-9_$]*$/;
const IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name);
}

export function assertModuleName(name: string): void {
  if (!PASCAL_CASE_IDENTIFIER.test(name)) {
    throw new InvalidModuleNameError(name);
  }
}
