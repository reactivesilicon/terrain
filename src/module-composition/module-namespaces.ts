import { type AccessorSpec, buildAccessorPrototype, instantiateAccessors } from "../accessors";
import { Container } from "../container/container";
import { DuplicateModuleNameError } from "../errors";
import { type AnyToken, isAsyncToken } from "../token";
import type { AsyncResolver, SyncResolver } from "../types";
import type { ResolverNamespaces } from "./kernel-definition-transformer";
import type { ModuleEntryName } from "./module-entry-definitions";
import type { ComposedModuleInternals, NamespacePrototypes } from "./module-internals";

export function buildNamespacePrototypes(
  tokensByEntryName: ReadonlyMap<ModuleEntryName, AnyToken<unknown>>,
): NamespacePrototypes {
  const accessorSpecWithAsyncEntries: AccessorSpec = {};
  const accessorSpecWithoutAsyncEntries: AccessorSpec = {};

  for (const [entryName, token] of tokensByEntryName) {
    accessorSpecWithAsyncEntries[entryName] = token;
    if (!isAsyncToken(token)) {
      accessorSpecWithoutAsyncEntries[entryName] = token;
    }
  }

  return {
    full: buildAccessorPrototype(accessorSpecWithAsyncEntries),
    syncOnly: buildAccessorPrototype(accessorSpecWithoutAsyncEntries),
  };
}

export function createResolverNamespaceBuilder(
  moduleName: string,
  usedModules: readonly ComposedModuleInternals[],
  namespacePrototypes: NamespacePrototypes,
): ResolverNamespaces {
  function buildResolverNamespaces(resolver: SyncResolver, includesAsyncEntries: false): Record<string, unknown>;
  function buildResolverNamespaces(resolver: AsyncResolver, includesAsyncEntries: true): Record<string, unknown>;
  function buildResolverNamespaces(
    resolver: SyncResolver | AsyncResolver,
    includesAsyncEntries: boolean,
  ): Record<string, unknown> {
    const namespacePrototypeKey = includesAsyncEntries ? "full" : "syncOnly";
    const namespaces: Record<string, unknown> = {};

    for (const usedModule of usedModules) {
      namespaces[usedModule.name] = instantiateAccessors(
        usedModule.namespacePrototypes[namespacePrototypeKey],
        resolver,
      );
    }

    namespaces[moduleName] = instantiateAccessors(namespacePrototypes[namespacePrototypeKey], resolver);
    return Object.freeze(namespaces);
  }

  return buildResolverNamespaces;
}

export function buildContainerNamespaces(
  container: Container,
  exposedModules: readonly ComposedModuleInternals[],
): Record<string, unknown> {
  const namespaces: Record<string, unknown> = {};

  for (const exposedModule of exposedModules) {
    if (exposedModule.name in namespaces) {
      throw new DuplicateModuleNameError(exposedModule.name);
    }

    namespaces[exposedModule.name] = instantiateAccessors(exposedModule.namespacePrototypes.full, container);
  }

  return namespaces;
}
