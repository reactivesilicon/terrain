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
import { type AnyToken, TokenModes } from "../token";
import { type Definition, type Lifetime, Lifetimes, type SingletonDefinitionOptions } from "../types";
import { assertModuleName } from "../validations/name-validations";
import { buildContainerView } from "./container-views";
import { toKernelDefinition } from "./kernel-definition-transformer";
import {
  type AsyncModuleEntryProvider,
  bundleModuleEntryDefinitionWithToken,
  ModuleEntryDefinitions,
  type ModuleEntryDefinitionWithToken,
  type ModuleEntryName,
  type SyncModuleEntryProvider,
} from "./module-entry-definitions";
import {
  type ComposedModuleInternals,
  findOverrideInternals,
  type OverrideInternals,
  requireModuleInternals,
  storeModuleInternals,
} from "./module-internals";
import { buildNamespacePrototypes, createResolverNamespaceBuilder } from "./module-namespaces";
import type { ModuleOverride } from "./module-override/module-override";
import { buildModuleOverride, buildOverrideKernelModule } from "./module-overrides";
import type {
  ComposedModule,
  ComposedModuleBuilder,
  ComposedModuleName,
  ContainerPart,
  ContainerView,
  ModuleEntryMap,
  PascalCase,
  UsedModules,
} from "./types";
import { assertNoNamespaceCollisions, wiringOf } from "./wiring";

export * from "./types";

function makeBuilder(
  moduleEntryDefinitions: ModuleEntryDefinitions,
): ComposedModuleBuilder<string, UsedModules, ModuleEntryMap> {
  const addSync =
    (lifetime: Lifetime) =>
    (entryName: ModuleEntryName, provider: SyncModuleEntryProvider, options?: SingletonDefinitionOptions<unknown>) => {
      moduleEntryDefinitions.register({
        entryName: entryName,
        lifetime: lifetime,
        mode: TokenModes.Sync,
        provider: provider,
        options: options,
      });
      return builder;
    };

  const addAsync =
    (lifetime: Lifetime) =>
    (entryName: ModuleEntryName, provider: AsyncModuleEntryProvider, options?: SingletonDefinitionOptions<unknown>) => {
      moduleEntryDefinitions.register({
        entryName: entryName,
        lifetime: lifetime,
        mode: TokenModes.Async,
        provider: provider,
        options: options,
      });
      return builder;
    };

  const builder = {
    single: addSync(Lifetimes.Singleton),
    singleAsync: addAsync(Lifetimes.Singleton),
    factory: addSync(Lifetimes.Factory),
    factoryAsync: addAsync(Lifetimes.Factory),
    scoped: addSync(Lifetimes.Scoped),
    scopedAsync: addAsync(Lifetimes.Scoped),
  } as unknown as ComposedModuleBuilder<string, UsedModules, ModuleEntryMap>;
  return builder;
}

// ── createModule ────────────────────────────────────────────────────────────

type RuntimeModuleBuilder = ComposedModuleBuilder<ComposedModuleName, UsedModules, ModuleEntryMap>;
type RuntimeModuleSetup = (composedModuleBuilder: RuntimeModuleBuilder) => unknown;

export function createModule<const ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap>(
  moduleName: PascalCase<ModuleName>,
  setup: (
    composedModuleBuilder: ComposedModuleBuilder<ModuleName, readonly [], {}>,
  ) => ComposedModuleBuilder<ModuleName, readonly [], ModuleEntries>,
): ComposedModule<ModuleName, ModuleEntries>;
export function createModule<
  const ModuleName extends ComposedModuleName,
  const Uses extends UsedModules,
  ModuleEntries extends ModuleEntryMap,
>(
  moduleName: PascalCase<ModuleName>,
  config: { uses: Uses },
  setup: (
    composedModuleBuilder: ComposedModuleBuilder<ModuleName, Uses, {}>,
  ) => ComposedModuleBuilder<ModuleName, Uses, ModuleEntries>,
): ComposedModule<ModuleName, ModuleEntries>;
export function createModule(
  moduleName: string,
  configOrSetup: { uses: readonly ComposedModule<ComposedModuleName, ModuleEntryMap>[] } | RuntimeModuleSetup,
  maybeSetup?: RuntimeModuleSetup,
): ComposedModule<string, ModuleEntryMap> {
  assertModuleName(moduleName);

  const usedModuleInternals = typeof configOrSetup === "function" ? [] : configOrSetup.uses.map(requireModuleInternals);
  const setup = (typeof configOrSetup === "function" ? configOrSetup : maybeSetup)!;

  assertNoNamespaceCollisions(moduleName, usedModuleInternals);

  const moduleEntryDefinitions = new ModuleEntryDefinitions(moduleName);
  setup(makeBuilder(moduleEntryDefinitions));

  const entryDefinitions = Array.from(moduleEntryDefinitions.registeredDefinitions());
  const entryDefinitionsWithTokens = entryDefinitions.map(bundleModuleEntryDefinitionWithToken.bind(null, moduleName));

  const tokensByEntryName = new Map<ModuleEntryName, AnyToken<unknown>>(
    entryDefinitionsWithTokens.map(({ token, entryName }) => [entryName, token]),
  );

  const namespacePrototypes = buildNamespacePrototypes(tokensByEntryName);

  const buildProviderResolverNamespaces = createResolverNamespaceBuilder(
    moduleName,
    usedModuleInternals,
    namespacePrototypes,
  );

  const definitionsByEntryName = new Map<ModuleEntryName, Definition<unknown>>();
  const entryDefinitionsByEntryName = new Map<ModuleEntryName, ModuleEntryDefinitionWithToken>();
  for (const entryDefinitionWithToken of entryDefinitionsWithTokens) {
    entryDefinitionsByEntryName.set(entryDefinitionWithToken.entryName, entryDefinitionWithToken);
    definitionsByEntryName.set(
      entryDefinitionWithToken.entryName,
      toKernelDefinition(entryDefinitionWithToken, buildProviderResolverNamespaces),
    );
  }
  const kernelModule = createKernelModule((moduleBuilder) => {
    for (const definition of definitionsByEntryName.values()) moduleBuilder.define(definition);
  });

  const moduleInternals: ComposedModuleInternals = {
    name: moduleName,
    definitionsByEntryName: definitionsByEntryName,
    entryDefinitionsByEntryName: entryDefinitionsByEntryName,
    kernelModule: kernelModule,
    usedModules: usedModuleInternals,
    namespacePrototypes: namespacePrototypes,
    buildProviderResolverNamespaces: buildProviderResolverNamespaces,
  };

  const module = {
    name: moduleName,
    override: (defineOverride: (overrideBuilder: unknown) => unknown): ModuleOverride<string> => {
      return buildModuleOverride(moduleName, entryDefinitionsByEntryName, moduleInternals, defineOverride);
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
  for (const wiringModule of wiring) {
    container.load(wiringModule.kernelModule);
  }
  for (const override of overrides) {
    container.load(buildOverrideKernelModule(override), { override: true });
  }

  return buildContainerView<Parts>(container, exposed);
}
