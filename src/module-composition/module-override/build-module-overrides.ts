import { InvalidModuleUseError } from "../../errors";
import { createModule as createKernelModule, type Module } from "../../module";
import { type AnyToken, type TokenMode, TokenModes } from "../../token";
import { Lifetimes } from "../../types";
import { tokenName } from "../../utils";
import { toKernelDefinition } from "../kernel-definition-transformer";
import {
  type AsyncModuleEntryDefinitionWithToken,
  type AsyncModuleEntryProvider,
  type ErasedDefinitionOptions,
  eraseAsyncEntryProvider,
  eraseSyncEntryProvider,
  type ModuleEntryDefinitionWithToken,
  type ModuleEntryName,
  type SyncModuleEntryDefinitionWithToken,
  type SyncModuleEntryProvider,
} from "../module-entry-definitions";
import { type ComposedModuleInternals, type OverrideInternals, storeOverrideInternals } from "../module-internals";
import type { ComposedModuleName } from "../types";
import type { ModuleEntryMap, OverrideBuilder } from "../types";
import { createModuleOverride, type ModuleOverride } from "./module-override";

export function buildModuleOverride<ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap>(
  moduleName: ModuleName,
  entryDefinitionsByEntryName: ReadonlyMap<ModuleEntryName, ModuleEntryDefinitionWithToken>,
  moduleInternals: ComposedModuleInternals,
  defineOverride: (
    overrideBuilder: OverrideBuilder<ModuleName, ModuleEntries>,
  ) => OverrideBuilder<ModuleName, ModuleEntries>,
): ModuleOverride<ModuleName> {
  const replacementsByEntryName = new Map<ModuleEntryName, ModuleEntryDefinitionWithToken>();

  function assertEntryCanBeReplaced(
    entryName: ModuleEntryName,
    expectedMode: typeof TokenModes.Sync,
    options?: ErasedDefinitionOptions,
  ): SyncModuleEntryDefinitionWithToken;
  function assertEntryCanBeReplaced(
    entryName: ModuleEntryName,
    expectedMode: typeof TokenModes.Async,
    options?: ErasedDefinitionOptions,
  ): AsyncModuleEntryDefinitionWithToken;
  function assertEntryCanBeReplaced(
    entryName: ModuleEntryName,
    expectedMode: TokenMode,
    options?: ErasedDefinitionOptions,
  ): ModuleEntryDefinitionWithToken {
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
    return original;
  }

  const collectSyncReplacement = <EntryName extends ModuleEntryName>(
    entryName: EntryName,
    provider: SyncModuleEntryProvider<ModuleName, ModuleEntries, EntryName>,
    options?: ErasedDefinitionOptions,
  ): OverrideBuilder<ModuleName, ModuleEntries> => {
    const original = assertEntryCanBeReplaced(entryName, TokenModes.Sync, options);
    replacementsByEntryName.set(entryName, { ...original, provider: eraseSyncEntryProvider(provider), options });
    return overrideBuilder;
  };

  const collectAsyncReplacement = <EntryName extends ModuleEntryName>(
    entryName: EntryName,
    provider: AsyncModuleEntryProvider<ModuleName, ModuleEntries, EntryName>,
    options?: ErasedDefinitionOptions,
  ): OverrideBuilder<ModuleName, ModuleEntries> => {
    const original = assertEntryCanBeReplaced(entryName, TokenModes.Async, options);
    replacementsByEntryName.set(entryName, { ...original, provider: eraseAsyncEntryProvider(provider), options });
    return overrideBuilder;
  };

  const overrideBuilder: OverrideBuilder<ModuleName, ModuleEntries> = {
    with: <EntryName extends ModuleEntryName>(
      entryName: EntryName,
      provider: SyncModuleEntryProvider<ModuleName, ModuleEntries, EntryName>,
      options?: ErasedDefinitionOptions,
    ) => collectSyncReplacement(entryName, provider, options),

    withAsync: <EntryName extends ModuleEntryName>(
      entryName: EntryName,
      provider: AsyncModuleEntryProvider<ModuleName, ModuleEntries, EntryName>,
      options?: ErasedDefinitionOptions,
    ) => collectAsyncReplacement(entryName, provider, options),
  };

  // Phantom-builder seam: overrideBuilder's runtime methods use looser generics
  // than the OverrideBuilder interface's entry-name constraints, so the object
  // is not structurally assignable to it. Irreducible; pinned by
  // test/runs/types.test.ts.
  defineOverride(overrideBuilder as any);
  if (replacementsByEntryName.size === 0) {
    throw new InvalidModuleUseError(`Override of module '${moduleName}' replaces nothing.`);
  }

  const override = createModuleOverride(moduleName);
  storeOverrideInternals(override, { targetModule: moduleInternals, replacementsByEntryName });
  return override;
}

// Two overrides replacing one entry have no right answer: load order would pick
// one silently.
export function assertNoEntryReplacedTwice(overrides: readonly OverrideInternals[]): void {
  const replacedTokens = new Set<AnyToken<unknown>>();
  for (const { replacementsByEntryName } of overrides) {
    for (const { token } of replacementsByEntryName.values()) {
      if (replacedTokens.has(token)) {
        throw new InvalidModuleUseError(
          `Entry '${tokenName(token)}' is replaced by more than one override in this container.`,
        );
      }
      replacedTokens.add(token);
    }
  }
}

export function buildOverrideKernelModule(override: OverrideInternals): Module {
  const { targetModule, replacementsByEntryName } = override;
  return createKernelModule((kernelModuleBuilder) => {
    for (const replacedEntry of replacementsByEntryName.values()) {
      kernelModuleBuilder.define(toKernelDefinition(replacedEntry, targetModule.buildProviderResolverNamespaces));
    }
  });
}
