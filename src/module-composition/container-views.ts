import { Container } from "../container/container";
import type { ComposedModuleInternals } from "./module-internals";
import { buildContainerNamespaces } from "./module-namespaces";
import type { ContainerPart, ContainerView, ScopeMethod, ScopeView } from "./types";

function buildScopeMethod<Parts extends readonly ContainerPart[]>(
  parentContainer: Container,
  exposedModules: readonly ComposedModuleInternals[],
): ScopeMethod<Parts> {
  function scope(): ScopeView<Parts>;
  function scope<T>(scopeWork: (view: ScopeView<Parts>) => T | Promise<T>): Promise<T>;
  function scope<T>(scopeWork?: (view: ScopeView<Parts>) => T | Promise<T>): ScopeView<Parts> | Promise<T> {
    if (!scopeWork) return buildScopeView(parentContainer.createScope(), exposedModules);
    return parentContainer.withScope((childScope) => scopeWork(buildScopeView(childScope, exposedModules)));
  }
  return scope;
}

export function buildScopeView<Parts extends readonly ContainerPart[]>(
  scopeContainer: Container,
  exposedModules: readonly ComposedModuleInternals[],
): ScopeView<Parts> {
  return Object.freeze(
    Object.assign(Object.create(null), buildContainerNamespaces(scopeContainer, exposedModules), {
      scope: buildScopeMethod<Parts>(scopeContainer, exposedModules),
      dispose: () => scopeContainer.dispose(),
    }),
  ) as ScopeView<Parts>;
}

export function buildContainerView<Parts extends readonly ContainerPart[]>(
  container: Container,
  exposedModules: readonly ComposedModuleInternals[],
): ContainerView<Parts> {
  return Object.freeze(
    Object.assign(Object.create(null), buildContainerNamespaces(container, exposedModules), {
      scope: buildScopeMethod<Parts>(container, exposedModules),
      start: () => container.start(),
      dispose: () => container.dispose(),
    }),
  ) as ContainerView<Parts>;
}
