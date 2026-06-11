import {
  AsyncProviderError,
  CaptiveDependencyError,
  CircularDependencyError,
  DefinitionInUseError,
  DependentInstanceError,
  DisposedContainerError,
  DuplicateDefinitionError,
  isFrameworkError,
  LifecycleOperationError,
  MissingDependencyError,
  ModuleOwnershipError,
  ProviderExecutionError,
  ShadowedDefinitionError,
  SyncProviderError,
} from "../errors";
import type { Module } from "../module";
import type { AnyToken, AsyncToken, Token } from "../token";
import {
  type AsyncDefinition,
  type AsyncResolver,
  type ContainerOptions,
  type Definition,
  type Disposer,
  type Lifetime,
  Lifetimes,
  type LoadOptions,
  type ResolutionFrame,
  type SyncDefinition,
  type SyncResolver,
} from "../types";
import { flattenErrors, tokenName } from "../utils";
import { DependencyGraph } from "./dependency-graph";
import { DisposableRegistry } from "./disposable-registry";
import { InstanceKinds, ResolutionCache } from "./resolution-cache";
import type { ResolutionHost } from "./resolution-host";

interface ResolvedDefinition<T> {
  definition: Definition<T>;
  owner: Container;
}

export class Container implements ResolutionHost {
  private parent?: Container;
  private readonly options: ContainerOptions;

  private definitions = new Map<AnyToken<any>, Definition<any>>();

  private readonly resolutionCache = new ResolutionCache(this);

  private readonly disposables = new DisposableRegistry();

  private children = new Set<Container>();
  private disposed = false;

  // Tokens currently being unloaded on THIS container. While present, the
  // token is treated as undefined by findOwner so in-flight providers cannot
  // re-resolve (and re-cache) it mid-unload.
  private unloading = new Set<AnyToken<any>>();

  // Guards against interleaved lifecycle ops. The flag lives on every node but
  // is only ever set/read on the tree ROOT, so a single lifecycle operation is
  // exclusive across the entire container tree.
  private lifecycleBusy = false;

  // Like the lifecycle flag: every node carries one, only the ROOT's is used.
  private readonly dependencyGraph = new DependencyGraph();

  constructor(options: ContainerOptions = {}) {
    this.options = options;
  }

  isUnloading(token: AnyToken<any>): boolean {
    return this.unloading.has(token);
  }

  trackDisposable<T>(token: AnyToken<T>, instance: T, dispose: Disposer<T>): void {
    this.disposables.track(token, instance, dispose);
  }

  invokeProviderSync<T>(definition: SyncDefinition<T>, chain: ResolutionFrame[]): T {
    return this.invokeProvider(definition, chain);
  }

  invokeProviderAsync<T>(definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T> {
    return this.invokeProvider(definition, chain);
  }

  private root(): Container {
    let current: Container = this;
    while (current.parent) current = current.parent;
    return current;
  }

  // True if this container or any ancestor is disposed.
  isTreeDisposed(): boolean {
    let current: Container | undefined = this;
    while (current) {
      if (current.disposed) return true;
      current = current.parent;
    }
    return false;
  }

  // Throws if this container OR any ancestor is disposed.
  private assertTreeUsable(): void {
    if (this.isTreeDisposed()) throw new DisposedContainerError();
  }

  // Acquire the tree-wide lifecycle lock (coordinated on the root). Returns the
  // root so the caller can release exactly what it acquired.
  private beginTreeLifecycle(): Container {
    const root = this.root();
    this.assertTreeUsable();
    if (root.lifecycleBusy) throw new LifecycleOperationError();
    root.lifecycleBusy = true;
    return root;
  }

  private endTreeLifecycle(root: Container): void {
    root.lifecycleBusy = false;
  }

  // ── Module management ─────────────────────────────────────────────────

  load(module: Module, options: LoadOptions = {}): void {
    const lock = this.beginTreeLifecycle();
    try {
      const entries = [...module.entries()];

      // Preflight: validate everything before mutating (transactional).
      for (const [token] of entries) {
        if (this.definedInAncestor(token) || this.definedInDescendant(token)) {
          throw new ShadowedDefinitionError(tokenName(token));
        }
        const exists = this.definitions.has(token);
        if (exists && !options.override) {
          throw new DuplicateDefinitionError(tokenName(token));
        }
        if (exists && options.override && this.hasCachedInstanceDeep(token)) {
          throw new DefinitionInUseError(tokenName(token));
        }
      }

      // Commit.
      for (const [token, definition] of entries) {
        const replacesExistingDefinition = this.definitions.has(token);
        this.definitions.set(token, definition);
        // The replaced definition has no live instance (preflight ensures it),
        // so its edges describe a dead incarnation and must not linger.
        if (replacesExistingDefinition) this.purgeDependencyEdges(token);
      }
    } finally {
      this.endTreeLifecycle(lock);
    }
  }

  // Best-effort, deterministic: validate ownership up front, mark tokens as
  // unloading (so in-flight providers can't re-resolve them), evict across
  // descendants disposing in reverse creation order, remove definitions, then
  // throw AggregateError if any disposal failed. Never leaves a half-unloaded
  // state, and never re-caches an evicted token.
  async unload(module: Module): Promise<void> {
    const lock = this.beginTreeLifecycle();
    try {
      const tokens = [...module.keys()];

      for (const token of tokens) {
        if (!this.definitions.has(token)) {
          throw new ModuleOwnershipError(tokenName(token));
        }
      }

      // Refuse before mutating anything: a cached (or in-flight) instance
      // outside the module that captured one of its instances would be left
      // holding a disposed dependency.
      const tokenSet = new Set(tokens);
      const liveDependents = this.collectLiveDependents(tokenSet);
      if (liveDependents.length > 0) {
        throw new DependentInstanceError(liveDependents.map(tokenName));
      }

      // Gate resolution of these tokens for the duration. findOwner() treats an
      // unloading token as absent, so an orphaned in-flight provider that resumes
      // mid-unload and calls get()/getAsync() for one of them fails fast instead
      // of re-creating and re-caching it after eviction.
      for (const token of tokens) this.markUnloadingDeep(token);

      try {
        const errors: unknown[] = [];
        await this.evictTokensDeep(tokenSet, errors);

        for (const token of tokens) {
          this.definitions.delete(token);
          this.purgeDependencyEdges(token);
        }

        if (errors.length > 0) {
          throw new AggregateError(flattenErrors(errors), "One or more instances failed during unload");
        }
      } finally {
        for (const token of tokens) this.unmarkUnloadingDeep(token);
      }
    } finally {
      this.endTreeLifecycle(lock);
    }
  }

  has<T>(token: AnyToken<T>): boolean {
    this.assertTreeUsable();
    return this.findOwner(token) !== undefined;
  }

  createScope(): Container {
    this.assertTreeUsable();
    const scope = new Container(this.options);
    scope.parent = this;
    this.children.add(scope);
    return scope;
  }

  // Run fn with a fresh scope that is always disposed afterwards. Preserves the
  // body error if disposal also fails.
  async withScope<T>(fn: (scope: Container) => T | Promise<T>): Promise<T> {
    const scope = this.createScope();

    let result: T | undefined;
    let bodyError: unknown;
    let failed = false;

    try {
      result = await fn(scope);
    } catch (error) {
      bodyError = error;
      failed = true;
    }

    try {
      await scope.dispose();
    } catch (disposeError) {
      if (failed) {
        throw new AggregateError(flattenErrors([bodyError, disposeError]), "Scope body and scope disposal both failed");
      }
      throw disposeError;
    }

    if (failed) throw bodyError;
    return result as T;
  }

  // ── Public resolution API ─────────────────────────────────────────────

  get<T>(token: Token<T>): T {
    return this.resolveSync(token, []);
  }

  getAsync<T>(token: AsyncToken<T>): Promise<T> {
    return this.resolveAsync(token, []);
  }

  inject<T>(token: Token<T>): () => T {
    this.assertTreeUsable();
    return () => this.get(token);
  }

  injectAsync<T>(token: AsyncToken<T>): () => Promise<T> {
    this.assertTreeUsable();
    return () => this.getAsync(token);
  }

  // ── Sync resolution ───────────────────────────────────────────────────

  private resolveSync<T>(token: Token<T>, chain: ResolutionFrame[]): T {
    // Tree-wide: a disposed ancestor makes the whole subtree unusable, even for
    // a child's own local definitions. Asserted here (not only in get()) because
    // providers hold resolver closures that call this directly.
    this.assertTreeUsable();

    const found = this.findOwner(token);
    if (!found) throw new MissingDependencyError(tokenName(token));
    const { definition, owner } = found;

    this.checkCircularDependency(token, chain);
    this.checkCaptiveDependency(definition, token, chain);
    if (definition.async) throw new AsyncProviderError(tokenName(token));
    this.recordResolvedDependency(token, chain);

    const next = this.extend(chain, token, definition.lifetime);
    switch (definition.lifetime) {
      case Lifetimes.Singleton:
        return owner.resolveSingletonSync(token, definition, next);
      case Lifetimes.Scoped:
        return this.resolveScopedSync(token, definition, next);
      case Lifetimes.Factory:
        return this.resolveFactorySync(definition, next);
      default: {
        const _exhaustive: never = definition.lifetime;
        throw new Error(`Unknown lifetime: ${String(_exhaustive)}`);
      }
    }
  }

  private resolveSingletonSync<T>(token: Token<T>, definition: SyncDefinition<T>, chain: ResolutionFrame[]): T {
    const cached = this.resolutionCache.getSyncInstance(InstanceKinds.Singleton, token);
    if (cached.has) return cached.value;
    const instance = this.invokeProvider(definition, chain);
    this.guardAfterConstruction(token, instance, definition.dispose);
    this.resolutionCache.commitSyncInstance(InstanceKinds.Singleton, token, instance, definition.dispose);
    return instance;
  }

  private resolveScopedSync<T>(token: Token<T>, definition: SyncDefinition<T>, chain: ResolutionFrame[]): T {
    const cached = this.resolutionCache.getSyncInstance(InstanceKinds.Scoped, token);
    if (cached.has) return cached.value;
    const instance = this.invokeProvider(definition, chain);
    this.guardAfterConstruction(token, instance, definition.dispose);
    this.resolutionCache.commitSyncInstance(InstanceKinds.Scoped, token, instance, definition.dispose);
    return instance;
  }

  // If the provider tore down this container (dispose, or unload of this token)
  // during its own synchronous construction, refuse to return/cache the result:
  // dispose the orphan (via its registered disposer, if any) and throw.
  private guardAfterConstruction<T>(token: Token<any>, instance: T, dispose?: Disposer<T>): void {
    if (this.isTreeDisposed() || this.unloading.has(token)) {
      if (dispose) {
        void Promise.resolve(dispose(instance)).catch((e) => this.notifyDisposeError(e));
      }
      throw new DisposedContainerError();
    }
  }

  private resolveFactorySync<T>(definition: SyncDefinition<T>, chain: ResolutionFrame[]): T {
    const instance = this.invokeProvider(definition, chain);
    this.guardAfterConstruction(definition.token, instance, definition.dispose);
    return instance;
  }

  // ── Async resolution ──────────────────────────────────────────────────

  private async resolveAsync<T>(token: AsyncToken<T>, chain: ResolutionFrame[]): Promise<T> {
    this.assertTreeUsable();

    const found = this.findOwner(token);
    if (!found) throw new MissingDependencyError(tokenName(token));
    const { definition, owner } = found;

    this.checkCircularDependency(token, chain);
    this.checkCaptiveDependency(definition, token, chain);
    if (!definition.async) throw new SyncProviderError(tokenName(token));
    this.recordResolvedDependency(token, chain);

    const next = this.extend(chain, token, definition.lifetime);
    switch (definition.lifetime) {
      case Lifetimes.Singleton:
        return owner.resolutionCache.resolveCachedAsync(InstanceKinds.Singleton, token, definition, next);
      case Lifetimes.Scoped:
        return this.resolutionCache.resolveCachedAsync(InstanceKinds.Scoped, token, definition, next);
      case Lifetimes.Factory:
        return this.resolutionCache.resolveFactoryAsync(definition, next);
      default: {
        const _exhaustive: never = definition.lifetime;
        throw new Error(`Unknown lifetime: ${String(_exhaustive)}`);
      }
    }
  }

  // Reporting hook is observational only: it must never alter lifecycle
  // behavior, so a throwing hook is swallowed.
  notifyDisposeError(error: unknown): void {
    try {
      this.options.onDisposeError?.(error);
    } catch {
      /* hooks are observational */
    }
  }

  // ── Provider invocation & error context ───────────────────────────────

  private invokeProvider<T>(definition: SyncDefinition<T>, chain: ResolutionFrame[]): T;
  private invokeProvider<T>(definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T>;
  private invokeProvider<T>(definition: Definition<T>, chain: ResolutionFrame[]): T | Promise<T> {
    try {
      if (definition.async) {
        const asyncResolver = this.makeAsyncResolver(chain);
        const asyncProvider = definition.provider;
        return asyncProvider(asyncResolver);
      }

      const syncResolver = this.makeSyncResolver(chain);
      const syncProvider = definition.provider;
      return syncProvider(syncResolver);
    } catch (error) {
      throw this.wrapProviderError(definition.token, error);
    }
  }

  wrapProviderError(token: AnyToken<any>, error: unknown): unknown {
    if (isFrameworkError(error)) return error;
    return new ProviderExecutionError(tokenName(token), error);
  }

  // ── Resolution plumbing ───────────────────────────────────────────────

  private makeSyncResolver(chain: ResolutionFrame[]): SyncResolver {
    return {
      get: <T>(token: Token<T>): T => this.resolveSync(token, chain),
      has: <T>(token: Token<T>): boolean => this.has(token),
    };
  }

  private makeAsyncResolver(chain: ResolutionFrame[]): AsyncResolver {
    return {
      get: <T>(token: Token<T>): T => this.resolveSync(token, chain),
      getAsync: <T>(token: AsyncToken<T>): Promise<T> => this.resolveAsync(token, chain),
      has: <T>(token: AnyToken<T>): boolean => this.has(token),
    };
  }

  private extend(chain: ResolutionFrame[], token: AnyToken<any>, lifetime: Lifetime): ResolutionFrame[] {
    return [...chain, { token, lifetime }];
  }

  private findOwner<T>(token: AnyToken<T>): ResolvedDefinition<T> | undefined {
    // Never resolve through a disposed container (defensive: also covers a
    // child left alive past an ancestor's disposal by some future bug).
    if (this.disposed) return undefined;
    const localDefinition = this.definitions.get(token);
    if (localDefinition) {
      // A token mid-unload is treated as absent so an in-flight provider that
      // resumes during unload cannot re-create/re-cache it.
      if (this.unloading.has(token)) return undefined;
      return { definition: localDefinition, owner: this };
    }
    return this.parent?.findOwner(token);
  }

  private definedInAncestor(token: AnyToken<any>): boolean {
    let ancestor = this.parent;
    while (ancestor) {
      if (ancestor.definitions.has(token)) return true;
      ancestor = ancestor.parent;
    }
    return false;
  }

  private definedInDescendant(token: AnyToken<any>): boolean {
    for (const child of this.children) {
      if (child.definitions.has(token) || child.definedInDescendant(token)) {
        return true;
      }
    }
    return false;
  }

  private markUnloadingDeep(token: AnyToken<any>): void {
    this.unloading.add(token);
    for (const child of this.children) child.markUnloadingDeep(token);
  }

  private unmarkUnloadingDeep(token: AnyToken<any>): void {
    this.unloading.delete(token);
    for (const child of this.children) child.unmarkUnloadingDeep(token);
  }

  // ── Dependent tracking (unload safety) ────────────────────────────────
  // The graph lives on the ROOT; Container contributes only what the graph
  // cannot know: when to record, and what counts as a live instance.

  private recordResolvedDependency(token: AnyToken<any>, chain: ResolutionFrame[]): void {
    this.root().dependencyGraph.recordResolvedDependency(token, chain);
  }

  private collectLiveDependents(unloadSet: ReadonlySet<AnyToken<any>>): AnyToken<any>[] {
    const root = this.root();
    return root.dependencyGraph.collectLiveDependents(unloadSet, (token) => root.hasCachedInstanceDeep(token));
  }

  private purgeDependencyEdges(token: AnyToken<any>): void {
    this.root().dependencyGraph.purge(token);
  }

  private checkCircularDependency(token: AnyToken<any>, chain: ResolutionFrame[]): void {
    if (chain.some((frame) => frame.token === token)) {
      throw new CircularDependencyError([...chain.map((f) => f.token), token].map(tokenName));
    }
  }

  private checkCaptiveDependency(definition: Definition<any>, token: AnyToken<any>, chain: ResolutionFrame[]): void {
    if (definition.lifetime !== Lifetimes.Scoped) return;
    const singletonAncestor = chain.find((f) => f.lifetime === Lifetimes.Singleton);
    if (singletonAncestor) {
      throw new CaptiveDependencyError(tokenName(singletonAncestor.token), tokenName(token));
    }
  }

  // ── Eviction (unload) ─────────────────────────────────────────────────

  private hasCachedInstanceDeep(token: AnyToken<any>): boolean {
    if (this.resolutionCache.hasCached(token)) return true;
    for (const child of this.children) {
      if (child.hasCachedInstanceDeep(token)) return true;
    }
    return false;
  }

  // Evict a set of tokens from THIS container, disposing their instances in
  // reverse creation order (dependents before dependencies), matching dispose().
  // Disposal records are token-keyed, so only the evicted tokens' own
  // disposers run — never another token's, even on a shared instance.
  private async evictTokensLocal(tokens: Set<AnyToken<any>>, errors: unknown[]): Promise<void> {
    for (const token of tokens) {
      this.resolutionCache.evictInstances(token);
      for (const p of this.resolutionCache.pendingForToken(token)) {
        try {
          await p;
        } catch {
          /* orphaned resolution */
        }
      }
      this.resolutionCache.deletePromisesForToken(token);
    }
    await this.disposables.disposeReverse({ targets: tokens, onError: (e) => errors.push(e) });
  }

  private async evictTokensDeep(tokens: Set<AnyToken<any>>, errors: unknown[]): Promise<void> {
    for (const child of this.children) {
      await child.evictTokensDeep(tokens, errors);
    }
    await this.evictTokensLocal(tokens, errors);
  }

  // ── Disposal ──────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // Acquire the tree-wide lock so dispose can't interleave with a load/unload
    // anywhere in the tree. Cascade disposal uses disposeInternal (no re-lock).
    const lock = this.beginTreeLifecycle();
    try {
      if (this.disposed) return; // re-check under lock
      await this.disposeInternal();
    } finally {
      this.endTreeLifecycle(lock);
    }
  }

  private async disposeInternal(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const errors: unknown[] = [];

    for (const child of this.children) {
      try {
        await child.disposeInternal();
      } catch (error) {
        errors.push(error);
      }
    }
    this.children.clear();

    for (const resolutionPromise of this.resolutionCache.allPendingResolutionPromises()) {
      try {
        await resolutionPromise;
      } catch {
        /* orphaned resolution */
      }
    }
    this.resolutionCache.clearResolutionPromises();

    await this.disposables.disposeReverse({ onError: (e) => errors.push(e) });

    this.resolutionCache.clearInstances();

    // Scope-local definitions die with this container; purge their edges
    // BEFORE detaching from the parent, while root() can still reach the
    // graph. The root's own graph dies with the root.
    if (this.parent) {
      for (const token of this.definitions.keys()) this.purgeDependencyEdges(token);
    }
    this.definitions.clear();

    this.parent?.children.delete(this);

    if (errors.length > 0) {
      throw new AggregateError(flattenErrors(errors), "One or more disposables failed to dispose");
    }
  }
}
