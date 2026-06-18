import type { ComposedModuleName } from "../composed-module";

declare const OVERRIDE_BRAND: unique symbol;

/** Replaces providers (and their options) of entries on the module it was
 *  derived from — entry names, value types, and modes are all checked against
 *  the original. Lifetime is inherited; consumers resolve the replacement
 *  transparently because the original's internal tokens are reused. */
export interface ModuleOverride<ModuleName extends ComposedModuleName> {
  readonly [OVERRIDE_BRAND]: true;
  readonly name: ModuleName;
}

class BuiltModuleOverride<ModuleName extends ComposedModuleName> implements ModuleOverride<ModuleName> {
  declare readonly [OVERRIDE_BRAND]: true;

  constructor(readonly name: ModuleName) {
    Object.freeze(this);
  }
}

export function createModuleOverride<ModuleName extends ComposedModuleName>(
  name: ModuleName,
): ModuleOverride<ModuleName> {
  return new BuiltModuleOverride(name);
}
