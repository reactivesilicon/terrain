import { ForeignModuleError } from "../errors";
import type { Module } from "../module";
import { TokenModes } from "../token";
import type { Definition, SingletonDefinitionOptions } from "../types";
import type { ResolverNamespaces } from "./kernel-definition-transformer";
import type {
  AsyncModuleEntryProvider,
  ModuleEntryDefinitionWithToken,
  ModuleEntryName,
  SyncModuleEntryProvider,
} from "./module-entry-definitions";
import type { ModuleOverride } from "./module-override/module-override";
import type { ComposedModule, ModuleEntryMap } from "./types";

export type NamespacePrototypes = {
  readonly full: object;
  readonly syncOnly: object;
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

export type EntryReplacement =
  | {
      mode: typeof TokenModes.Sync;
      provider: SyncModuleEntryProvider;
      options: SingletonDefinitionOptions<unknown> | undefined;
    }
  | {
      mode: typeof TokenModes.Async;
      provider: AsyncModuleEntryProvider;
      options: SingletonDefinitionOptions<unknown> | undefined;
    };

export interface OverrideInternals {
  targetModule: ComposedModuleInternals;
  replacementsByEntryName: ReadonlyMap<ModuleEntryName, EntryReplacement>;
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
