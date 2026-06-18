import type { ModuleOverride } from "./module-override/module-override";
import type { ComposedModuleName, ModuleEntryMap, OverrideBuilder } from "./types";

declare const COMPOSED_MODULE_BRAND: unique symbol;

type BuildModuleOverride<ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap> = (
  build: (overrideBuilder: OverrideBuilder<ModuleName, ModuleEntries>) => OverrideBuilder<ModuleName, ModuleEntries>,
) => ModuleOverride<ModuleName>;

export interface ComposedModule<ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap> {
  readonly [COMPOSED_MODULE_BRAND]: true;
  readonly name: ModuleName;
  /** Phantom — carries the entry map for resolver/accessor/import typing. */
  readonly __entries?: ModuleEntries;
  override(
    build: (overrideBuilder: OverrideBuilder<ModuleName, ModuleEntries>) => OverrideBuilder<ModuleName, ModuleEntries>,
  ): ModuleOverride<ModuleName>;
}

class BuiltComposedModule<
  ModuleName extends ComposedModuleName,
  ModuleEntries extends ModuleEntryMap,
> implements ComposedModule<ModuleName, ModuleEntries> {
  declare readonly [COMPOSED_MODULE_BRAND]: true;
  declare readonly __entries?: ModuleEntries;

  readonly #buildModuleOverride: BuildModuleOverride<ModuleName, ModuleEntries>;

  constructor(
    readonly name: ModuleName,
    buildModuleOverride: BuildModuleOverride<ModuleName, ModuleEntries>,
  ) {
    this.#buildModuleOverride = buildModuleOverride;
    Object.freeze(this);
  }

  override(
    build: (overrideBuilder: OverrideBuilder<ModuleName, ModuleEntries>) => OverrideBuilder<ModuleName, ModuleEntries>,
  ): ModuleOverride<ModuleName> {
    return this.#buildModuleOverride(build);
  }
}

export function createComposedModule<ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap>(
  name: ModuleName,
  buildModuleOverride: BuildModuleOverride<ModuleName, ModuleEntries>,
): ComposedModule<ModuleName, ModuleEntries> {
  return new BuiltComposedModule(name, buildModuleOverride);
}
