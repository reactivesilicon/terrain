/* oxlint-disable no-unused-vars */

import type { Simplify, UnionToIntersection } from "../kernel/types";
import { type TokenMode, TokenModes } from "../token";
import type { ContainerOptions, DefinitionOptions, SingletonDefinitionOptions } from "../types";
import type { ComposedModule } from "./composed-module";
import type { ModuleEntryName } from "./module-entry-definitions";
import type { ModuleOverride } from "./module-override/module-override";

// ── type-level model ────────────────────────────────────────────────────────
// Each named definition contributes one Entry to its module's EntryMap. The
// map is phantom: it exists so resolvers, accessors, and cross-module imports
// are typed — the runtime works purely on internally minted tokens.

export type ComposedModuleName = string;

export type ModuleEntry<T, Mode extends TokenMode> = { value: T; mode: Mode };
export type ModuleEntryMap = Record<string, ModuleEntry<unknown, TokenMode>>;

type ModuleEntryByEntryName<EntryName extends ModuleEntryName, T, Mode extends TokenMode> = {
  [K in EntryName]: ModuleEntry<T, Mode>;
};

// ── type-level accessors ─────────────────────────────────────────────────────
// @ts-ignore
type EntryNamesOf<ModuleEntries extends ModuleEntryMap> = keyof ModuleEntries;
type SyncEntryNamesOf<ModuleEntries extends ModuleEntryMap> = {
  [K in keyof ModuleEntries]: ModuleEntries[K] extends ModuleEntry<unknown, typeof TokenModes.Sync> ? K : never;
}[keyof ModuleEntries];
type AsyncEntryNamesOf<ModuleEntries extends ModuleEntryMap> = {
  [K in keyof ModuleEntries]: ModuleEntries[K] extends ModuleEntry<unknown, typeof TokenModes.Async> ? K : never;
}[keyof ModuleEntries];

export type EntryValueOf<ModuleEntries extends ModuleEntryMap, EntryName extends keyof ModuleEntries> =
  ModuleEntries[EntryName] extends ModuleEntry<infer T, TokenMode> ? T : never;

export type UsedModules = readonly ComposedModule<ComposedModuleName, ModuleEntryMap>[];

// ── accessors ──────────────────────────────────────────────────────────────
export type ModuleAccessorsOf<ModuleEntries extends ModuleEntryMap> = Simplify<
  SyncModuleAccessorsOf<ModuleEntries> & AsyncModuleAccessorsOf<ModuleEntries>
>;

type SyncModuleAccessorsOf<ModuleEntries extends ModuleEntryMap> = {
  readonly [EntryName in SyncEntryNamesOf<ModuleEntries>]: () => EntryValueOf<ModuleEntries, EntryName>;
};

type AsyncModuleAccessorsOf<ModuleEntries extends ModuleEntryMap> = {
  readonly [EntryName in AsyncEntryNamesOf<ModuleEntries>]: () => Promise<EntryValueOf<ModuleEntries, EntryName>>;
};

// ── namespaces ─────────────────────────────────────────────────────────────
type NamespaceOf<Module> =
  Module extends ComposedModule<infer ModuleName, infer ModuleEntries>
    ? { readonly [K in ModuleName]: ModuleAccessorsOf<ModuleEntries> }
    : never;

type SyncNamespaceOf<Module> =
  Module extends ComposedModule<infer ModuleName, infer ModuleEntries>
    ? { readonly [K in ModuleName]: SyncModuleAccessorsOf<ModuleEntries> }
    : never;

type AsyncNamespaceOf<Module> =
  Module extends ComposedModule<infer ModuleName, infer ModuleEntries>
    ? { readonly [K in ModuleName]: AsyncModuleAccessorsOf<ModuleEntries> }
    : never;

// ── import namespaces ───────────────────────────────────────────────────────
type ImportNamespaces<Uses extends UsedModules> = Uses extends readonly []
  ? {}
  : UnionToIntersection<NamespaceOf<Uses[number]>>;

type SyncImportNamespaces<Uses extends UsedModules> = Uses extends readonly []
  ? {}
  : UnionToIntersection<SyncNamespaceOf<Uses[number]>>;

// @ts-ignore
type AsyncImportNamespaces<Uses extends UsedModules> = Uses extends readonly []
  ? {}
  : UnionToIntersection<AsyncNamespaceOf<Uses[number]>>;

// ── builder ─────────────────────────────────────────────────────────────────

// The resolver is namespaces all the way down: imported modules under their
// names, and the module's own earlier entries under ITS name — one uniform
// call shape, identical to the container view.
export type SyncProviderResolver<
  ModuleName extends ComposedModuleName,
  Uses extends UsedModules,
  ModuleEntries extends ModuleEntryMap,
> = SyncImportNamespaces<Uses> & { readonly [K in ModuleName]: SyncModuleAccessorsOf<ModuleEntries> };

export type AsyncProviderResolver<
  ModuleName extends ComposedModuleName,
  Uses extends UsedModules,
  ModuleEntries extends ModuleEntryMap,
> = ImportNamespaces<Uses> & { readonly [K in ModuleName]: ModuleAccessorsOf<ModuleEntries> };

export interface ComposedModuleBuilder<
  ModuleName extends ComposedModuleName,
  Uses extends UsedModules,
  ModuleEntries extends ModuleEntryMap,
> {
  single<const EntryName extends ModuleEntryName, T>(
    entryName: EntryName,
    provider: (r: SyncProviderResolver<ModuleName, Uses, ModuleEntries>) => T,
    options?: SingletonDefinitionOptions<T>,
  ): ComposedModuleBuilder<
    ModuleName,
    Uses,
    ModuleEntries & ModuleEntryByEntryName<EntryName, T, typeof TokenModes.Sync>
  >;

  singleAsync<const EntryName extends ModuleEntryName, T>(
    entryName: EntryName,
    provider: (r: AsyncProviderResolver<ModuleName, Uses, ModuleEntries>) => Promise<T>,
    options?: SingletonDefinitionOptions<T>,
  ): ComposedModuleBuilder<
    ModuleName,
    Uses,
    ModuleEntries & ModuleEntryByEntryName<EntryName, T, typeof TokenModes.Async>
  >;

  factory<const EntryName extends ModuleEntryName, T>(
    entryName: EntryName,
    provider: (r: SyncProviderResolver<ModuleName, Uses, ModuleEntries>) => T,
    options?: DefinitionOptions<T>,
  ): ComposedModuleBuilder<
    ModuleName,
    Uses,
    ModuleEntries & ModuleEntryByEntryName<EntryName, T, typeof TokenModes.Sync>
  >;

  factoryAsync<const EntryName extends ModuleEntryName, T>(
    entryName: EntryName,
    provider: (r: AsyncProviderResolver<ModuleName, Uses, ModuleEntries>) => Promise<T>,
    options?: DefinitionOptions<T>,
  ): ComposedModuleBuilder<
    ModuleName,
    Uses,
    ModuleEntries & ModuleEntryByEntryName<EntryName, T, typeof TokenModes.Async>
  >;

  scoped<const EntryName extends ModuleEntryName, T>(
    entryName: EntryName,
    provider: (r: SyncProviderResolver<ModuleName, Uses, ModuleEntries>) => T,
    options?: DefinitionOptions<T>,
  ): ComposedModuleBuilder<
    ModuleName,
    Uses,
    ModuleEntries & ModuleEntryByEntryName<EntryName, T, typeof TokenModes.Sync>
  >;

  scopedAsync<const EntryName extends ModuleEntryName, T>(
    entryName: EntryName,
    provider: (r: AsyncProviderResolver<ModuleName, Uses, ModuleEntries>) => Promise<T>,
    options?: DefinitionOptions<T>,
  ): ComposedModuleBuilder<
    ModuleName,
    Uses,
    ModuleEntries & ModuleEntryByEntryName<EntryName, T, typeof TokenModes.Async>
  >;
}

/** Override providers may resolve the module's OTHER entries (Omit of the one
 *  being replaced); the original's imports are reachable at runtime but not
 *  typed here — fakes are expected to be self-contained. */
export interface OverrideBuilder<ModuleName extends ComposedModuleName, ModuleEntries extends ModuleEntryMap> {
  with<EntryName extends SyncEntryNamesOf<ModuleEntries> & ModuleEntryName>(
    entryName: EntryName,
    provider: (
      resolver: SyncProviderResolver<ModuleName, readonly [], Omit<ModuleEntries, EntryName>>,
    ) => EntryValueOf<ModuleEntries, EntryName>,
    options?: SingletonDefinitionOptions<EntryValueOf<ModuleEntries, EntryName>>,
  ): OverrideBuilder<ModuleName, ModuleEntries>;
  withAsync<EntryName extends AsyncEntryNamesOf<ModuleEntries> & ModuleEntryName>(
    entryName: EntryName,
    provider: (
      resolver: AsyncProviderResolver<ModuleName, readonly [], Omit<ModuleEntries, EntryName>>,
    ) => Promise<EntryValueOf<ModuleEntries, EntryName>>,
    options?: SingletonDefinitionOptions<EntryValueOf<ModuleEntries, EntryName>>,
  ): OverrideBuilder<ModuleName, ModuleEntries>;
}

/** What createContainer accepts: modules (exposed as namespaces) and module
 *  overrides (rewire only), mixed in one list. */
export type ContainerPart = ComposedModule<ComposedModuleName, ModuleEntryMap> | ModuleOverride<ComposedModuleName>;

/** Input to createContainer: the modules/overrides to compose, plus optional
 *  root ContainerOptions (e.g. onDisposeError). Scopes inherit these options. */
export interface ContainerConfig<Parts extends readonly ContainerPart[]> {
  readonly parts: Parts;
  readonly options?: ContainerOptions;
}

export type Namespaces<Parts extends readonly ContainerPart[]> = UnionToIntersection<NamespaceOf<Parts[number]>>;

/** No-arg: a child scope view you dispose() yourself. Callback: the scope is
 *  created, handed to the work, and ALWAYS disposed afterwards (the engine's
 *  withScope semantics — body errors preserved, both-fail aggregated). */
export interface ScopeMethod<Parts extends readonly ContainerPart[]> {
  (): ScopeView<Parts>;
  <T>(work: (view: ScopeView<Parts>) => T | Promise<T>): Promise<T>;
}

export type ContainerView<Parts extends readonly ContainerPart[]> = Simplify<
  Namespaces<Parts> & {
    scope: ScopeMethod<Parts>;
    start(): Promise<void>;
    dispose(): Promise<void>;
  }
>;

export type ScopeView<Parts extends readonly ContainerPart[]> = Simplify<
  Namespaces<Parts> & {
    /** Scopes nest: a request scope can open transaction sub-scopes. */
    scope: ScopeMethod<Parts>;
    dispose(): Promise<void>;
  }
>;

/** Module names must be PascalCase. The container view's API (scope, start,
 *  dispose — and anything added later) is lowercase, so namespaces and
 *  methods can never collide, with no reserved-word list to maintain. */
export type PascalCase<Name extends string> = Name extends Capitalize<Name> ? Name : never;
