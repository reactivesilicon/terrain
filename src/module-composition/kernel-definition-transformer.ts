import { TokenModes } from "../token";
import {
  type AsyncResolver,
  type Definition,
  Lifetimes,
  type SingletonDefinitionOptions,
  type SyncResolver,
} from "../types";
import type { ModuleEntryDefinitionWithToken } from "./module-entry-definitions";

export type ResolverNamespaces = {
  (resolver: SyncResolver, includesAsyncEntries: false): Record<string, unknown>;
  (resolver: AsyncResolver, includesAsyncEntries: true): Record<string, unknown>;
};

function singletonDefinitionOptions(options: SingletonDefinitionOptions<unknown> | undefined) {
  return {
    ...(options?.dispose ? { dispose: options.dispose } : {}),
    ...(options?.eager ? { eager: true } : {}),
  };
}

function nonSingletonDefinitionOptions(options: SingletonDefinitionOptions<unknown> | undefined) {
  return options?.dispose ? { dispose: options.dispose } : {};
}

export function toKernelDefinition(
  entryDefinition: ModuleEntryDefinitionWithToken,
  resolverNamespaces: ResolverNamespaces,
): Definition<unknown> {
  const options =
    entryDefinition.lifetime === Lifetimes.Singleton
      ? { lifetime: entryDefinition.lifetime, ...singletonDefinitionOptions(entryDefinition.options) }
      : { lifetime: entryDefinition.lifetime, ...nonSingletonDefinitionOptions(entryDefinition.options) };

  switch (entryDefinition.mode) {
    case TokenModes.Sync: {
      const provider = (resolver: SyncResolver) => entryDefinition.provider(resolverNamespaces(resolver, false));
      return {
        token: entryDefinition.token,
        async: false,
        provider: provider,
        ...options,
      } satisfies Definition<unknown>;
    }
    case TokenModes.Async: {
      const provider = (resolver: AsyncResolver) => entryDefinition.provider(resolverNamespaces(resolver, true));
      return {
        token: entryDefinition.token,
        async: true,
        provider: provider,
        ...options,
      } satisfies Definition<unknown>;
    }
  }
}
