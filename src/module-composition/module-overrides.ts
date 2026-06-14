import { InvalidModuleUseError } from "../errors";
import { createModule as createTokenModule, type Module } from "../module";
import { type TokenMode, TokenModes } from "../token";
import { type Definition, Lifetimes, type SingletonDefinitionOptions } from "../types";
import { toKernelDefinition } from "./kernel-definition-transformer";
import type { ModuleEntryName, ModuleEntryProvider } from "./module-entry-definitions";
import {
  type ComposedModuleInternals,
  type EntryReplacement,
  type OverrideInternals,
  storeOverrideInternals,
} from "./module-internals";
import type { ModuleOverride } from "./types";

export function buildModuleOverride(
  moduleName: string,
  definitionsByEntryName: ReadonlyMap<ModuleEntryName, Definition<unknown>>,
  moduleInternals: ComposedModuleInternals,
  defineOverride: (overrideBuilder: unknown) => unknown,
): ModuleOverride<string> {
  const replacementsByEntryName = new Map<ModuleEntryName, EntryReplacement>();

  const collectReplacement = (
    entryName: ModuleEntryName,
    expectedMode: TokenMode,
    provider: ModuleEntryProvider,
    options?: SingletonDefinitionOptions<unknown>,
  ) => {
    const original = definitionsByEntryName.get(entryName);
    // Runtime backstops; the typed surface makes these unwritable.
    if (!original) {
      throw new InvalidModuleUseError(`Override targets unknown entry '${entryName}' in module '${moduleName}'.`);
    }
    const mode = original.async ? TokenModes.Async : TokenModes.Sync;
    if (mode !== expectedMode) {
      throw new InvalidModuleUseError(
        `Entry '${moduleName}.${entryName}' is ${mode}; use the matching override method.`,
      );
    }
    if (replacementsByEntryName.has(entryName)) {
      throw new InvalidModuleUseError(`Override of module '${moduleName}' already replaces entry '${entryName}'.`);
    }
    const opts = options as SingletonDefinitionOptions<unknown> | undefined;
    if (opts?.eager && original.lifetime !== Lifetimes.Singleton) {
      throw new InvalidModuleUseError(
        `Override of '${moduleName}.${entryName}' cannot be eager: the original is ${original.lifetime}, not a singleton.`,
      );
    }
    replacementsByEntryName.set(entryName, { provider, options: opts });
    return overrideBuilder;
  };

  const overrideBuilder = {
    with: (entryName: ModuleEntryName, provider: ModuleEntryProvider, options?: SingletonDefinitionOptions<unknown>) =>
      collectReplacement(entryName, TokenModes.Sync, provider, options),
    withAsync: (
      entryName: ModuleEntryName,
      provider: ModuleEntryProvider,
      options?: SingletonDefinitionOptions<unknown>,
    ) => collectReplacement(entryName, TokenModes.Async, provider, options),
  };

  defineOverride(overrideBuilder);
  if (replacementsByEntryName.size === 0) {
    throw new InvalidModuleUseError(`Override of module '${moduleName}' replaces nothing.`);
  }

  const override = Object.freeze({ name: moduleName }) as unknown as ModuleOverride<string>;
  storeOverrideInternals(override, { targetModule: moduleInternals, replacementsByEntryName });
  return override;
}

export function buildOverrideKernelModule(override: OverrideInternals): Module {
  const { targetModule, replacementsByEntryName } = override;
  return createTokenModule((kernelModuleBuilder) => {
    for (const [entryName, replacement] of replacementsByEntryName) {
      const originalDefinition = targetModule.definitionsByEntryName.get(entryName)!;
      kernelModuleBuilder.define(
        toKernelDefinition(
          originalDefinition,
          targetModule.buildProviderResolverNamespaces,
          replacement.provider,
          replacement.options ?? {},
        ),
      );
    }
  });
}
