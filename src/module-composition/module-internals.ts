import { ForeignModuleError } from "../errors";
import type { Module } from "../module";
import type { Definition, SingletonDefinitionOptions } from "../types";
import type { ResolverNamespaces } from "./kernel-definition-transformer";
import type { ModuleEntryName, ModuleEntryProvider } from "./module-entry-definitions";
import type { EntryMap, ModuleOverride, ComposedModule } from "./types";

export type NamespacePrototypes = {
  readonly full: object;
  readonly syncOnly: object;
};

export interface ComposedModuleInternals {
  name: string;
  definitionsByEntryName: ReadonlyMap<ModuleEntryName, Definition<unknown>>;
  kernelModule: Module;
  usedModules: readonly ComposedModuleInternals[];
  namespacePrototypes: NamespacePrototypes;
  buildProviderResolverNamespaces: ResolverNamespaces;
}

export interface EntryReplacement {
  provider: ModuleEntryProvider;
  options: SingletonDefinitionOptions<unknown> | undefined;
}

export interface OverrideInternals {
  targetModule: ComposedModuleInternals;
  replacementsByEntryName: ReadonlyMap<ModuleEntryName, EntryReplacement>;
}

const internalsByModule = new WeakMap<ComposedModule<string, EntryMap>, ComposedModuleInternals>();
const internalsByOverride = new WeakMap<ModuleOverride<string>, OverrideInternals>();

export function storeModuleInternals(
  module: ComposedModule<string, EntryMap>,
  internals: ComposedModuleInternals,
): void {
  internalsByModule.set(module, internals);
}

export function requireModuleInternals(module: ComposedModule<string, EntryMap>): ComposedModuleInternals {
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
