// Caveats, documented:
// - Go-to-definition on r.Infra.logger lands on a mapped type, not the
//   provider — inherent to computed accessor types (token variables in the
//   1.0 API jump better).
// - The chain is the contract: capturing `m` and registering imperatively
//   (e.g. inside an if) registers at runtime but is invisible to the types.
//   Keep setup a single returned chain.

import { Container } from "../container/container";
import { InvalidModuleUseError } from "../errors";
import { createModule as createKernelModule } from "../module";
import { type AnyToken, createAsyncToken, createSyncToken, type TokenMode, TokenModes } from "../token";
import { type Definition, type Lifetime, Lifetimes, type SingletonDefinitionOptions } from "../types";
import { assertModuleName } from "../validations/name-validations";
import { buildContainerView } from "./container-views";
import { type KernelDefinitionInput, toKernelDefinition } from "./kernel-definition-transformer";
import { ModuleEntryDefinitions, type ModuleEntryName, type ModuleEntryProvider } from "./module-entry-definitions";
import {
  type ComposedModuleInternals,
  findOverrideInternals,
  type OverrideInternals,
  requireModuleInternals,
  storeModuleInternals,
} from "./module-internals";
import { buildNamespacePrototypes, createResolverNamespaceBuilder } from "./module-namespaces";
import { buildModuleOverride, buildOverrideKernelModule } from "./module-overrides";
import type {
  ComposedModule,
  ComposedModuleBuilder,
  ComposedModuleName,
  ContainerPart,
  ContainerView,
  ModuleEntryMap,
  ModuleOverride,
  PascalCase,
  UsedModules,
} from "./types";
import { assertNoNamespaceCollisions, wiringOf } from "./wiring";

export * from "./types";

function makeBuilder(
  moduleEntryDefinitions: ModuleEntryDefinitions,
): ComposedModuleBuilder<string, UsedModules, ModuleEntryMap> {
  const add =
    (lifetime: Lifetime, mode: TokenMode) =>
    (entryName: string, provider: ModuleEntryProvider, options?: SingletonDefinitionOptions<unknown>) => {
      moduleEntryDefinitions.register({ entryName, lifetime, mode, provider, options });
      return builder;
    };

  const builder = {
    single: add(Lifetimes.Singleton, TokenModes.Sync),
    singleAsync: add(Lifetimes.Singleton, TokenModes.Async),
    factory: add(Lifetimes.Factory, TokenModes.Sync),
    factoryAsync: add(Lifetimes.Factory, TokenModes.Async),
    scoped: add(Lifetimes.Scoped, TokenModes.Sync),
    scopedAsync: add(Lifetimes.Scoped, TokenModes.Async),
  } as unknown as ComposedModuleBuilder<string, UsedModules, ModuleEntryMap>;
  return builder;
}

// ── createModule ────────────────────────────────────────────────────────────

export function createModule<const ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap>(
  name: PascalCase<ModuleName>,
  setup: (
    composedModuleBuilder: ComposedModuleBuilder<ModuleName, readonly [], {}>,
  ) => ComposedModuleBuilder<ModuleName, readonly [], ModuleEntries>,
): ComposedModule<ModuleName, ModuleEntries>;
export function createModule<
  const ModuleName extends ComposedModuleName,
  const Uses extends UsedModules,
  ModuleEntries extends ModuleEntryMap,
>(
  name: PascalCase<ModuleName>,
  config: { uses: Uses },
  setup: (
    composedModuleBuilder: ComposedModuleBuilder<ModuleName, Uses, {}>,
  ) => ComposedModuleBuilder<ModuleName, Uses, ModuleEntries>,
): ComposedModule<ModuleName, ModuleEntries>;
export function createModule(
  name: string,
  configOrSetup: { uses: readonly ComposedModule<string, ModuleEntryMap>[] } | ((m: never) => unknown),
  maybeSetup?: (m: never) => unknown,
): ComposedModule<string, ModuleEntryMap> {
  assertModuleName(name);

  const usedModuleInternals = typeof configOrSetup === "function" ? [] : configOrSetup.uses.map(requireModuleInternals);
  const setup = (typeof configOrSetup === "function" ? configOrSetup : maybeSetup)!;

  assertNoNamespaceCollisions(name, usedModuleInternals);

  const moduleEntryDefinitions = new ModuleEntryDefinitions(name);
  setup(makeBuilder(moduleEntryDefinitions) as never);

  // This module's own entries; imports are reached via resolver namespaces.
  const tokensByEntryName = new Map<ModuleEntryName, AnyToken<unknown>>();
  for (const definition of moduleEntryDefinitions.registeredDefinitions()) {
    const description = `${name}.${definition.entryName}`;
    const token =
      definition.mode === TokenModes.Async
        ? createAsyncToken<unknown>(description)
        : createSyncToken<unknown>(description);
    tokensByEntryName.set(definition.entryName, token);
  }

  const namespacePrototypes = buildNamespacePrototypes(tokensByEntryName);

  const buildProviderResolverNamespaces = createResolverNamespaceBuilder(
    name,
    usedModuleInternals,
    namespacePrototypes,
  );

  const definitionsByEntryName = new Map<ModuleEntryName, Definition<unknown>>();
  for (const definition of moduleEntryDefinitions.registeredDefinitions()) {
    const token = tokensByEntryName.get(definition.entryName)!;
    const kernelDefinitionInput: KernelDefinitionInput = {
      token: token,
      lifetime: definition.lifetime,
      async: definition.mode === TokenModes.Async,
    };
    definitionsByEntryName.set(
      definition.entryName,
      toKernelDefinition(
        kernelDefinitionInput,
        buildProviderResolverNamespaces,
        definition.provider,
        definition.options ?? {},
      ),
    );
  }
  const kernelModule = createKernelModule((m) => {
    for (const definition of definitionsByEntryName.values()) m.define(definition);
  });

  const moduleInternals: ComposedModuleInternals = {
    name: name,
    definitionsByEntryName: definitionsByEntryName,
    kernelModule: kernelModule,
    usedModules: usedModuleInternals,
    namespacePrototypes: namespacePrototypes,
    buildProviderResolverNamespaces: buildProviderResolverNamespaces,
  };

  const module = {
    name,
    override: (defineOverride: (overrideBuilder: unknown) => unknown): ModuleOverride<string> => {
      return buildModuleOverride(name, definitionsByEntryName, moduleInternals, defineOverride);
    },
  } as unknown as ComposedModule<string, ModuleEntryMap>;
  Object.freeze(module);
  storeModuleInternals(module, moduleInternals);
  return module;
}

export function createContainer<const Parts extends readonly ContainerPart[]>(...parts: Parts): ContainerView<Parts> {
  const exposed: ComposedModuleInternals[] = [];
  const overrides: OverrideInternals[] = [];
  for (const part of parts) {
    const overrideInternals = findOverrideInternals(part as ModuleOverride<string>);
    if (overrideInternals) overrides.push(overrideInternals);
    else exposed.push(requireModuleInternals(part as ComposedModule<string, ModuleEntryMap>));
  }

  const wiring = wiringOf(exposed);

  for (const override of overrides) {
    if (!wiring.has(override.targetModule)) {
      throw new InvalidModuleUseError(
        `Override targets module '${override.targetModule.name}' which is not part of this container's wiring.`,
      );
    }
  }

  const container = new Container();
  for (const module of wiring) container.load(module.kernelModule);
  for (const override of overrides) {
    container.load(buildOverrideKernelModule(override), { override: true });
  }

  return buildContainerView<Parts>(container, exposed);
}
