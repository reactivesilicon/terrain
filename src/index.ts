// Composition-first public API. The token kernel (tokens, Container, the
// definition-set builder, accessors) is internal — minted and managed by the
// composition layer, never handed to consumers.
// Only errors the public API can throw. Engine-only ones (load/unload, raw
// token resolution) stay internal to the engine.
export {
  CaptiveDependencyError,
  CircularDependencyError,
  DIError,
  DisposedContainerError,
  DuplicateEntryNameError,
  DuplicateModuleNameError,
  ForeignModuleError,
  InvalidEntryNameError,
  InvalidModuleNameError,
  InvalidModuleUseError,
  isFrameworkError,
  ProviderExecutionError,
} from "./errors";
export * from "./module-composition";
export type { Disposer, FactoryDefinitionOptions, ScopedDefinitionOptions, SingletonDefinitionOptions } from "./types";
