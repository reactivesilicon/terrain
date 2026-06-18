import { InvalidModuleUseError } from "../errors";
import { createModule as createKernelModule, type Module } from "../module";
import { TokenModes } from "../token";
import { Lifetimes, type SingletonDefinitionOptions } from "../types";
import { toKernelDefinition } from "./kernel-definition-transformer";
import type {
  AsyncModuleEntryProvider,
  ModuleEntryDefinitionWithToken,
  ModuleEntryName,
  SyncModuleEntryProvider,
} from "./module-entry-definitions";
import {
  type ComposedModuleInternals,
  type EntryReplacement,
  type OverrideInternals,
  storeOverrideInternals,
} from "./module-internals";
import { createModuleOverride, type ModuleOverride } from "./module-override/module-override";

export function buildModuleOverride(
  moduleName: string,
  entryDefinitionsByEntryName: ReadonlyMap<ModuleEntryName, ModuleEntryDefinitionWithToken>,
  moduleInternals: ComposedModuleInternals,
  defineOverride: (overrideBuilder: unknown) => unknown,
): ModuleOverride<string> {
  const replacementsByEntryName = new Map<ModuleEntryName, EntryReplacement>();

  const assertEntryCanBeReplaced = (
    entryName: ModuleEntryName,
    expectedMode: typeof TokenModes.Sync | typeof TokenModes.Async,
    options?: SingletonDefinitionOptions<unknown>,
  ): void => {
    const original = entryDefinitionsByEntryName.get(entryName);
    if (!original) {
      throw new InvalidModuleUseError(`Override targets unknown entry '${entryName}' in module '${moduleName}'.`);
    }
    if (original.mode !== expectedMode) {
      throw new InvalidModuleUseError(
        `Entry '${moduleName}.${entryName}' is ${original.mode}; use the matching override method.`,
      );
    }
    if (replacementsByEntryName.has(entryName)) {
      throw new InvalidModuleUseError(`Override of module '${moduleName}' already replaces entry '${entryName}'.`);
    }
    if (options?.eager && original.lifetime !== Lifetimes.Singleton) {
      throw new InvalidModuleUseError(
        `Override of '${moduleName}.${entryName}' cannot be eager: the original is ${original.lifetime}, not a singleton.`,
      );
    }
  };

  const collectSyncReplacement = (
    entryName: ModuleEntryName,
    provider: SyncModuleEntryProvider,
    options?: SingletonDefinitionOptions<unknown>,
  ) => {
    assertEntryCanBeReplaced(entryName, TokenModes.Sync, options);
    replacementsByEntryName.set(entryName, { mode: TokenModes.Sync, provider, options });
    return overrideBuilder;
  };

  const collectAsyncReplacement = (
    entryName: ModuleEntryName,
    provider: AsyncModuleEntryProvider,
    options?: SingletonDefinitionOptions<unknown>,
  ) => {
    assertEntryCanBeReplaced(entryName, TokenModes.Async, options);
    replacementsByEntryName.set(entryName, { mode: TokenModes.Async, provider, options });
    return overrideBuilder;
  };

  const overrideBuilder = {
    with: (
      entryName: ModuleEntryName,
      provider: SyncModuleEntryProvider,
      options?: SingletonDefinitionOptions<unknown>,
    ) => collectSyncReplacement(entryName, provider, options),

    withAsync: (
      entryName: ModuleEntryName,
      provider: AsyncModuleEntryProvider,
      options?: SingletonDefinitionOptions<unknown>,
    ) => collectAsyncReplacement(entryName, provider, options),
  };

  defineOverride(overrideBuilder);
  if (replacementsByEntryName.size === 0) {
    throw new InvalidModuleUseError(`Override of module '${moduleName}' replaces nothing.`);
  }

  const override = createModuleOverride(moduleName);
  storeOverrideInternals(override, { targetModule: moduleInternals, replacementsByEntryName });
  return override;
}

export function buildOverrideKernelModule(override: OverrideInternals): Module {
  const { targetModule, replacementsByEntryName } = override;
  return createKernelModule((kernelModuleBuilder) => {
    for (const [entryName, replacement] of replacementsByEntryName) {
      const originalEntry = targetModule.entryDefinitionsByEntryName.get(entryName);

      if (!originalEntry) {
        throw new InvalidModuleUseError(
          `Override targets unknown entry '${entryName}' in module '${targetModule.name}'.`,
        );
      }

      const replacedEntry =
        originalEntry.mode === TokenModes.Sync && replacement.mode === TokenModes.Sync
          ? { ...originalEntry, provider: replacement.provider, options: replacement.options }
          : originalEntry.mode === TokenModes.Async && replacement.mode === TokenModes.Async
            ? { ...originalEntry, provider: replacement.provider, options: replacement.options }
            : undefined;

      if (!replacedEntry) {
        throw new InvalidModuleUseError(`Replacement mode does not match original entry '${entryName}'.`);
      }

      kernelModuleBuilder.define(toKernelDefinition(replacedEntry, targetModule.buildProviderResolverNamespaces));
    }
  });
}
