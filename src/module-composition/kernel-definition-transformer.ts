import type { AnyToken } from "../token";
import type { AsyncResolver, Definition, Lifetime, SingletonDefinitionOptions, SyncResolver } from "../types";
import type { ModuleEntryProvider } from "./module-entry-definitions";

export type ResolverNamespaces = {
  (resolver: SyncResolver, includesAsyncEntries: false): Record<string, unknown>;
  (resolver: AsyncResolver, includesAsyncEntries: true): Record<string, unknown>;
};

export type KernelDefinitionInput = {
  token: AnyToken<unknown>;
  lifetime: Lifetime;
  async: boolean;
};

export function toKernelDefinition(
  kernelDefinitionInput: KernelDefinitionInput,
  resolverNamespaces: ResolverNamespaces,
  moduleEntryProvider: ModuleEntryProvider,
  options: SingletonDefinitionOptions<unknown>,
): Definition<unknown> {
  const provider = kernelDefinitionInput.async
    ? (resolver: AsyncResolver) => moduleEntryProvider(resolverNamespaces(resolver, true))
    : (resolver: SyncResolver) => moduleEntryProvider(resolverNamespaces(resolver, false));

  return {
    token: kernelDefinitionInput.token,
    lifetime: kernelDefinitionInput.lifetime,
    async: kernelDefinitionInput.async,
    provider: provider,
    ...(options.dispose ? { dispose: options.dispose } : {}),
    ...(options.eager ? { eager: true } : {}),
  } as Definition<unknown>; // TODO: check types with satisfies and remove assertion
}
