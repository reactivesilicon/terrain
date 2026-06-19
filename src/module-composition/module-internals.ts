import type { AccessorPrototype } from "../accessors";
import { ForeignModuleError } from "../errors";
import type { Module } from "../module";
import type { AsyncResolver, Definition, SyncResolver } from "../types";
import type { ComposedModule } from "./composed-module";
import type { ResolverNamespaces } from "./kernel-definition-transformer";
import type { ModuleEntryDefinitionWithToken, ModuleEntryName } from "./module-entry-definitions";
import type { ModuleOverride } from "./module-override/module-override";
import type { ModuleEntryMap } from "./types";

export type NamespacePrototypes = {
  readonly full: AccessorPrototype<AsyncResolver>;
  readonly syncOnly: AccessorPrototype<SyncResolver>;
};

export interface ComposedModuleInternals {
  name: string;
  definitionsByEntryName: ReadonlyMap<ModuleEntryName, Definition<unknown>>;
  entryDefinitionsByEntryName: ReadonlyMap<ModuleEntryName, ModuleEntryDefinitionWithToken>;
  kernelModule: Module;
  usedModules: readonly ComposedModuleInternals[];
  namespacePrototypes: NamespacePrototypes;
  buildProviderResolverNamespaces: ResolverNamespaces;
}

export interface OverrideInternals {
  targetModule: ComposedModuleInternals;
  replacementsByEntryName: ReadonlyMap<ModuleEntryName, ModuleEntryDefinitionWithToken>;
}

const internalsByModule = new WeakMap<ComposedModule<string, ModuleEntryMap>, ComposedModuleInternals>();
const internalsByOverride = new WeakMap<ModuleOverride<string>, OverrideInternals>();

export function storeModuleInternals(
  module: ComposedModule<string, ModuleEntryMap>,
  internals: ComposedModuleInternals,
): void {
  internalsByModule.set(module, internals);
}

export function requireModuleInternals(module: ComposedModule<string, ModuleEntryMap>): ComposedModuleInternals {
  const internals = internalsByModule.get(module);
  if (!internals) {
    throw new ForeignModuleError();
  }
  return internals;
}

export function storeOverrideInternals(override: ModuleOverride<string>, internals: OverrideInternals): void {
  internalsByOverride.set(override, internals);
}

export function findOverrideInternals(override: ModuleOverride<string>): OverrideInternals | undefined {
  return internalsByOverride.get(override);
}
