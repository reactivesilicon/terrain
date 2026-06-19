// Composition-first public API. The token kernel (tokens, Container, the
// definition-set builder, accessors) is internal — minted and managed by the
// composition layer, never handed to consumers.
export * from "./errors";
export * from "./module-composition";
export type { DefinitionOptions, Disposer, SingletonDefinitionOptions } from "./types";
