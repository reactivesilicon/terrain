import { TokenModes } from "../token";
import { type AsyncResolver, type Definition, Lifetimes, type SyncResolver } from "../types";
import type { ModuleEntryDefinitionWithToken } from "./module-entry-definitions";

export type ResolverNamespaces = {
  forSyncProvider(resolver: SyncResolver): Record<string, unknown>;
  forAsyncProvider(resolver: AsyncResolver): Record<string, unknown>;
};

function lifetimeOptions({ lifetime, options }: ModuleEntryDefinitionWithToken) {
  switch (lifetime) {
    case Lifetimes.Singleton:
      return {
        lifetime,
        ...(options?.dispose ? { dispose: options.dispose } : {}),
        ...(options?.eager ? { eager: true } : {}),
      };
    case Lifetimes.Scoped:
      return { lifetime, ...(options?.dispose ? { dispose: options.dispose } : {}) };
    case Lifetimes.Factory:
      return { lifetime, ...(options?.disposeUnclaimed ? { dispose: options.disposeUnclaimed } : {}) };
  }
}

export function toKernelDefinition(
  entryDefinition: ModuleEntryDefinitionWithToken,
  resolverNamespaces: ResolverNamespaces,
): Definition<unknown> {
  const options = lifetimeOptions(entryDefinition);

  switch (entryDefinition.mode) {
    case TokenModes.Sync: {
      const provider = (resolver: SyncResolver) =>
        entryDefinition.provider(resolverNamespaces.forSyncProvider(resolver));
      return {
        token: entryDefinition.token,
        async: false,
        provider: provider,
        ...options,
      } satisfies Definition<unknown>;
    }
    case TokenModes.Async: {
      const provider = (resolver: AsyncResolver) =>
        entryDefinition.provider(resolverNamespaces.forAsyncProvider(resolver));
      return {
        token: entryDefinition.token,
        async: true,
        provider: provider,
        ...options,
      } satisfies Definition<unknown>;
    }
  }
}
