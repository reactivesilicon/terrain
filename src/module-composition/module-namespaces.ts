import {
  type AccessorPrototype,
  type AccessorSpec,
  buildAccessorPrototype,
  buildSyncAccessorPrototype,
  type SyncAccessorSpec,
} from "../accessors";
import { Container } from "../container/container";
import { DuplicateModuleNameError } from "../errors";
import { type AnyToken, isAsyncToken } from "../token";
import type { SyncResolver } from "../types";
import type { ResolverNamespaces } from "./kernel-definition-transformer";
import type { ModuleEntryName } from "./module-entry-definitions";
import type { ComposedModuleInternals, NamespacePrototypes } from "./module-internals";

export function buildNamespacePrototypes(
  tokensByEntryName: ReadonlyMap<ModuleEntryName, AnyToken<unknown>>,
): NamespacePrototypes {
  const allEntries: AccessorSpec = {};
  const syncEntries: SyncAccessorSpec = {};

  for (const [entryName, token] of tokensByEntryName) {
    allEntries[entryName] = token;
    if (!isAsyncToken(token)) {
      syncEntries[entryName] = token;
    }
  }

  return {
    full: buildAccessorPrototype(allEntries),
    syncOnly: buildSyncAccessorPrototype(syncEntries),
  };
}

export function createResolverNamespaceBuilder(
  moduleName: string,
  usedModules: readonly ComposedModuleInternals[],
  namespacePrototypes: NamespacePrototypes,
): ResolverNamespaces {
  function buildNamespaces<Source extends SyncResolver>(
    ownPrototype: AccessorPrototype<Source>,
    usedPrototype: (used: ComposedModuleInternals) => AccessorPrototype<Source>,
    resolver: Source,
  ): Record<string, unknown> {
    const namespaces: Record<string, unknown> = Object.create(null);
    for (const used of usedModules) {
      namespaces[used.name] = usedPrototype(used).instantiate(resolver);
    }
    namespaces[moduleName] = ownPrototype.instantiate(resolver);
    return Object.freeze(namespaces);
  }

  return {
    forSyncProvider: (resolver) =>
      buildNamespaces(namespacePrototypes.syncOnly, (used) => used.namespacePrototypes.syncOnly, resolver),
    forAsyncProvider: (resolver) =>
      buildNamespaces(namespacePrototypes.full, (used) => used.namespacePrototypes.full, resolver),
  };
}

export function buildContainerNamespaces(
  container: Container,
  exposedModules: readonly ComposedModuleInternals[],
): Record<string, unknown> {
  const namespaces: Record<string, unknown> = Object.create(null);

  for (const exposedModule of exposedModules) {
    if (exposedModule.name in namespaces) {
      throw new DuplicateModuleNameError(exposedModule.name);
    }

    namespaces[exposedModule.name] = exposedModule.namespacePrototypes.full.instantiate(container);
  }

  return namespaces;
}
