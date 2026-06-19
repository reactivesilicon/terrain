// Public surface of the module-composition layer. Only the names users touch
// are re-exported here; the entry/resolver/namespace type machinery in
// ./types stays internal.

export { createContainer, createModule } from "./composition";
export type { ComposedModule } from "./composed-module";
export type { ModuleOverride } from "./module-override/module-override";
export type { ComposedModuleBuilder, ContainerPart, ContainerView, OverrideBuilder, ScopeView } from "./types";
