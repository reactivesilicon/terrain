import {
  AsyncProviderError,
  CaptiveDependencyError,
  CircularDependencyError,
  DefinitionInUseError,
  DisposedContainerError,
  DuplicateDefinitionError,
  isFrameworkError,
  LifecycleOperationError,
  MissingDependencyError,
  ModuleOwnershipError,
  ProviderExecutionError,
  ShadowedDefinitionError,
  SyncProviderError,
} from "./errors"

import {
  type AsyncDefinition,
  type AsyncResolver,
  type ContainerOptions,
  type Definition,
  type Disposable,
  type Lifetime,
  Lifetimes,
  type LoadOptions,
  type SyncDefinition,
  type SyncResolver,
} from "./types"

import type {Token} from "./token"

import type {Module} from "./module"
import {flattenErrors, isDisposable, tokenName} from "./utils";

interface ResolutionFrame {
  token: Token<any>
  lifetime: Lifetime
}

interface ResolvedDefinition<T> {
  definition: Definition<T>
  owner: Container
}

// Structurally compatible with AsyncResolver (has get/getAsync/has) but does
// not declare `implements`, so the public container API can evolve without
// being tied to resolver semantics.
export class Container {
  private parent?: Container
  private readonly options: ContainerOptions

  private definitions = new Map<Token<any>, Definition<any>>()

  private singletonInstances = new Map<Token<any>, any>()
  private singletonResolutionPromises = new Map<Token<any>, Promise<any>>()
  private scopedInstances = new Map<Token<any>, any>()
  private scopedResolutionPromises = new Map<Token<any>, Promise<any>>()
  // In-flight async factory resolutions, grouped by token. Factories are
  // caller-owned once built, but tracking lets teardown await/orphan them.
  private factoryResolutionPromises = new Map<Token<any>, Set<Promise<any>>>()

  private disposables: Disposable[] = []
  private disposableSet = new Set<Disposable>()

  private children = new Set<Container>()
  private disposed = false

  // Tokens currently being unloaded on THIS container. While present, the
  // token is treated as undefined by findOwner so in-flight providers cannot
  // re-resolve (and re-cache) it mid-unload.
  private unloading = new Set<Token<any>>()

  // Guards against interleaved lifecycle ops. The flag lives on every node but
  // is only ever set/read on the tree ROOT, so a single lifecycle operation is
  // exclusive across the entire container tree.
  private lifecycleBusy = false

  constructor(options: ContainerOptions = {}) {
    this.options = options
  }

  private root(): Container {
    let current: Container = this
    while (current.parent) current = current.parent
    return current
  }

  // True if this container or any ancestor is disposed.
  private isTreeDisposed(): boolean {
    let current: Container | undefined = this
    while (current) {
      if (current.disposed) return true
      current = current.parent
    }
    return false
  }

  // Throws if this container OR any ancestor is disposed.
  private assertTreeUsable(): void {
    if (this.isTreeDisposed()) throw new DisposedContainerError()
  }

  // Acquire the tree-wide lifecycle lock (coordinated on the root). Returns the
  // root so the caller can release exactly what it acquired.
  private beginTreeLifecycle(): Container {
    const root = this.root()
    this.assertTreeUsable()
    if (root.lifecycleBusy) throw new LifecycleOperationError()
    root.lifecycleBusy = true
    return root
  }

  private endTreeLifecycle(root: Container): void {
    root.lifecycleBusy = false
  }

  // ── Module management ─────────────────────────────────────────────────

  load(module: Module, options: LoadOptions = {}): void {
    const lock = this.beginTreeLifecycle()
    try {
      const entries = [...module.entries()]

      // Preflight: validate everything before mutating (transactional).
      for (const [token] of entries) {
        if (this.definedInAncestor(token) || this.definedInDescendant(token)) {
          throw new ShadowedDefinitionError(tokenName(token))
        }
        const exists = this.definitions.has(token)
        if (exists && !options.override) {
          throw new DuplicateDefinitionError(tokenName(token))
        }
        if (exists && options.override && this.hasCachedInstanceDeep(token)) {
          throw new DefinitionInUseError(tokenName(token))
        }
      }

      // Commit.
      for (const [token, definition] of entries) {
        this.definitions.set(token, definition)
      }
    } finally {
      this.endTreeLifecycle(lock)
    }
  }

  // Best-effort, deterministic: validate ownership up front, mark tokens as
  // unloading (so in-flight providers can't re-resolve them), evict across
  // descendants disposing in reverse creation order, remove definitions, then
  // throw AggregateError if any disposal failed. Never leaves a half-unloaded
  // state, and never re-caches an evicted token.
  async unload(module: Module): Promise<void> {
    const lock = this.beginTreeLifecycle()
    try {
      const tokens = [...module.keys()]

      for (const token of tokens) {
        if (!this.definitions.has(token)) {
          throw new ModuleOwnershipError(tokenName(token))
        }
      }

      // Gate resolution of these tokens for the duration. findOwner() treats an
      // unloading token as absent, so an orphaned in-flight provider that resumes
      // mid-unload and calls get()/getAsync() for one of them fails fast instead
      // of re-creating and re-caching it after eviction.
      const tokenSet = new Set(tokens)
      for (const token of tokens) this.markUnloadingDeep(token)

      try {
        const errors: unknown[] = []
        await this.evictTokensDeep(tokenSet, errors)

        for (const token of tokens) {
          this.definitions.delete(token)
        }

        if (errors.length > 0) {
          throw new AggregateError(flattenErrors(errors), "One or more instances failed during unload")
        }
      } finally {
        for (const token of tokens) this.unmarkUnloadingDeep(token)
      }
    } finally {
      this.endTreeLifecycle(lock)
    }
  }

  has<T>(token: Token<T>): boolean {
    this.assertTreeUsable()
    return this.findOwner(token) !== undefined
  }

  createScope(): Container {
    this.assertTreeUsable()
    const scope = new Container(this.options)
    scope.parent = this
    this.children.add(scope)
    return scope
  }

  // Run fn with a fresh scope that is always disposed afterwards. Preserves the
  // body error if disposal also fails.
  async withScope<T>(fn: (scope: Container) => T | Promise<T>): Promise<T> {
    const scope = this.createScope()

    let result: T | undefined
    let bodyError: unknown
    let failed = false

    try {
      result = await fn(scope)
    } catch (error) {
      bodyError = error
      failed = true
    }

    try {
      await scope.dispose()
    } catch (disposeError) {
      if (failed) {
        throw new AggregateError(
          flattenErrors([bodyError, disposeError]),
          "Scope body and scope disposal both failed",
        )
      }
      throw disposeError
    }

    if (failed) throw bodyError
    return result as T
  }

  // ── Public resolution API ─────────────────────────────────────────────

  get<T>(token: Token<T>): T {
    return this.resolveSync(token, [])
  }

  getAsync<T>(token: Token<T>): Promise<T> {
    return this.resolveAsync(token, [])
  }

  inject<T>(token: Token<T>): () => T {
    this.assertTreeUsable()
    return () => this.get(token)
  }

  injectAsync<T>(token: Token<T>): () => Promise<T> {
    this.assertTreeUsable()
    return () => this.getAsync(token)
  }

  // ── Sync resolution ───────────────────────────────────────────────────

  private resolveSync<T>(token: Token<T>, chain: ResolutionFrame[]): T {
    // Tree-wide: a disposed ancestor makes the whole subtree unusable, even for
    // a child's own local definitions. Asserted here (not only in get()) because
    // providers hold resolver closures that call this directly.
    this.assertTreeUsable()

    const found = this.findOwner(token)
    if (!found) throw new MissingDependencyError(tokenName(token))
    const {definition, owner} = found

    this.checkCircularDependency(token, chain)
    this.checkCaptiveDependency(definition, token, chain)
    if (definition.async) throw new AsyncProviderError(tokenName(token))

    const next = this.extend(chain, token, definition.lifetime)
    switch (definition.lifetime) {
      case Lifetimes.Singleton:
        return owner.resolveSingletonSync(token, definition, next)
      case Lifetimes.Scoped:
        return this.resolveScopedSync(token, definition, next)
      case Lifetimes.Factory:
        return this.resolveFactorySync(definition, next)
      default: {
        const _exhaustive: never = definition.lifetime
        throw new Error(`Unknown lifetime: ${String(_exhaustive)}`)
      }
    }
  }

  private resolveSingletonSync<T>(token: Token<T>, definition: SyncDefinition<T>, chain: ResolutionFrame[]): T {
    if (this.singletonInstances.has(token)) return this.singletonInstances.get(token)
    const instance = this.invokeProvider(definition, chain)
    this.guardAfterConstruction(token, instance)
    this.singletonInstances.set(token, instance)
    this.trackDisposable(instance)
    return instance
  }

  private resolveScopedSync<T>(token: Token<T>, definition: SyncDefinition<T>, chain: ResolutionFrame[]): T {
    if (this.scopedInstances.has(token)) return this.scopedInstances.get(token)
    const instance = this.invokeProvider(definition, chain)
    this.guardAfterConstruction(token, instance)
    this.scopedInstances.set(token, instance)
    this.trackDisposable(instance)
    return instance
  }

  // If the provider tore down this container (dispose, or unload of this token)
  // during its own synchronous construction, refuse to return/cache the result:
  // dispose the orphan and throw.
  private guardAfterConstruction(token: Token<any>, instance: unknown): void {
    if (this.isTreeDisposed() || this.unloading.has(token)) {
      if (isDisposable(instance)) {
        void Promise.resolve(instance.dispose()).catch((e) => this.notifyDisposeError(e))
      }
      throw new DisposedContainerError()
    }
  }

  private resolveFactorySync<T>(definition: SyncDefinition<T>, chain: ResolutionFrame[]): T {
    const instance = this.invokeProvider(definition, chain)
    this.guardAfterConstruction(definition.token, instance)
    return instance
  }

  // ── Async resolution ──────────────────────────────────────────────────

  private async resolveAsync<T>(token: Token<T>, chain: ResolutionFrame[]): Promise<T> {
    this.assertTreeUsable()

    const found = this.findOwner(token)
    if (!found) throw new MissingDependencyError(tokenName(token))
    const {definition, owner} = found

    this.checkCircularDependency(token, chain)
    this.checkCaptiveDependency(definition, token, chain)
    if (!definition.async) throw new SyncProviderError(tokenName(token))

    const next = this.extend(chain, token, definition.lifetime)
    switch (definition.lifetime) {
      case Lifetimes.Singleton:
        return owner.resolveSingletonAsync(token, definition, next)
      case Lifetimes.Scoped:
        return this.resolveScopedAsync(token, definition, next)
      case Lifetimes.Factory:
        return this.resolveFactoryAsync(definition, next)
      default: {
        const _exhaustive: never = definition.lifetime
        throw new Error(`Unknown lifetime: ${String(_exhaustive)}`)
      }
    }
  }

  /**
   * Guards a cache-writing async resolution: runs the build, then refuses to commit if the tree was torn down / token unloaded / a newer resolution won.
   * */
  private async resolveGuarded<T>({token, build, isStale}: {
    token: Token<any>,
    build: () => Promise<T>,
    isStale: () => boolean,
  }): Promise<T> {
    let instance: T
    try {
      instance = await build()
    } catch (error) {
      throw this.wrapProviderError(token, error)
    }
    if (this.isTreeDisposed() || this.unloading.has(token) || isStale()) {
      await this.disposeOrphan(instance)
      throw new DisposedContainerError()
    }
    return instance
  }

  private async resolveCachedAsync<T>(
    token: Token<T>,
    definition: AsyncDefinition<T>,
    chain: ResolutionFrame[],
    instances: Map<Token<any>, any>,
    resolutionPromises: Map<Token<any>, Promise<any>>,
  ): Promise<T> {
    if (instances.has(token)) return instances.get(token)
    const pending = resolutionPromises.get(token)
    if (pending) return pending

    let promise: Promise<T>
    promise = this.resolveGuarded({
      token: token,
      build: async () => await this.invokeProvider(definition, chain),
      isStale: () => resolutionPromises.get(token) !== promise,
    })
    resolutionPromises.set(token, promise)

    const settledResolution = await promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    )

    if (settledResolution.ok) {
      instances.set(token, settledResolution.value)
      this.trackDisposable(settledResolution.value)
      resolutionPromises.delete(token)
      return settledResolution.value
    }

    if (resolutionPromises.get(token) === promise) resolutionPromises.delete(token)
    throw settledResolution.error
  }

  private resolveSingletonAsync<T>(token: Token<T>, definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T> {
    return this.resolveCachedAsync(token, definition, chain, this.singletonInstances, this.singletonResolutionPromises)
  }

  private resolveScopedAsync<T>(token: Token<T>, definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T> {
    return this.resolveCachedAsync(token, definition, chain, this.scopedInstances, this.scopedResolutionPromises)
  }

  private async resolveFactoryAsync<T>(definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T> {
    const token = definition.token

    let pendingTokenResolutionPromises = this.factoryResolutionPromises.get(token)
    if (!pendingTokenResolutionPromises) {
      pendingTokenResolutionPromises = new Set()
      this.factoryResolutionPromises.set(token, pendingTokenResolutionPromises)
    }

    const tokenResolutionPromise = this.resolveGuarded({
      token: token,
      build: async () => await this.invokeProvider(definition, chain),
      isStale: () => false,
    })
    pendingTokenResolutionPromises.add(tokenResolutionPromise)

    const settledResolution = await tokenResolutionPromise.then(
      (value) => ({ok: true as const, value}),
      (error) => ({ok: false as const, error}),
    )

    this.cleanupPendingPromise(token, tokenResolutionPromise)

    if (settledResolution.ok) return settledResolution.value
    throw settledResolution.error
  }

  private cleanupPendingPromise(token: Token<any>, promise: Promise<unknown>): void {
    const pendingTokenResolutionPromises = this.factoryResolutionPromises.get(token)
    if (!pendingTokenResolutionPromises) return
    pendingTokenResolutionPromises.delete(promise)
    if (pendingTokenResolutionPromises.size === 0) this.factoryResolutionPromises.delete(token)
  }

  private async disposeOrphan(instance: unknown): Promise<void> {
    if (!isDisposable(instance)) return
    try {
      await instance.dispose()
    } catch (error) {
      this.notifyDisposeError(error)
    }
  }

  // Reporting hook is observational only: it must never alter lifecycle
  // behavior, so a throwing hook is swallowed.
  private notifyDisposeError(error: unknown): void {
    try {
      this.options.onDisposeError?.(error)
    } catch {
      /* hooks are observational */
    }
  }

  // ── Provider invocation & error context ───────────────────────────────

  private invokeProvider<T>(definition: SyncDefinition<T>, chain: ResolutionFrame[]): T
  private invokeProvider<T>(definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T>
  private invokeProvider<T>(definition: Definition<T>, chain: ResolutionFrame[]): T | Promise<T> {
    try {
      if (definition.async) {
        const asyncResolver= this.makeAsyncResolver(chain)
        const asyncProvider = definition.provider
        return asyncProvider(asyncResolver)
      }

      const syncResolver = this.makeSyncResolver(chain)
      const syncProvider = definition.provider
      return syncProvider(syncResolver)
    } catch (error) {
      throw this.wrapProviderError(definition.token, error)
    }
  }

  private wrapProviderError(token: Token<any>, error: unknown): unknown {
    if (isFrameworkError(error)) return error
    return new ProviderExecutionError(tokenName(token), error)
  }

  // ── Resolution plumbing ───────────────────────────────────────────────

  private makeSyncResolver(chain: ResolutionFrame[]): SyncResolver {
    return {
      get: <T>(token: Token<T>): T => this.resolveSync(token, chain),
      has: <T>(token: Token<T>): boolean => this.has(token),
    }
  }

  private makeAsyncResolver(chain: ResolutionFrame[]): AsyncResolver {
    return {
      get: <T>(token: Token<T>): T => this.resolveSync(token, chain),
      getAsync: <T>(token: Token<T>): Promise<T> => this.resolveAsync(token, chain),
      has: <T>(token: Token<T>): boolean => this.has(token),
    }
  }

  private extend(chain: ResolutionFrame[], token: Token<any>, lifetime: Lifetime): ResolutionFrame[] {
    return [...chain, {token, lifetime}]
  }

  private findOwner<T>(token: Token<T>): ResolvedDefinition<T> | undefined {
    // Never resolve through a disposed container (defensive: also covers a
    // child left alive past an ancestor's disposal by some future bug).
    if (this.disposed) return undefined
    const localDefinition = this.definitions.get(token)
    if (localDefinition) {
      // A token mid-unload is treated as absent so an in-flight provider that
      // resumes during unload cannot re-create/re-cache it.
      if (this.unloading.has(token)) return undefined
      return {definition: localDefinition, owner: this}
    }
    return this.parent?.findOwner(token)
  }

  private definedInAncestor(token: Token<any>): boolean {
    let ancestor = this.parent
    while (ancestor) {
      if (ancestor.definitions.has(token)) return true
      ancestor = ancestor.parent
    }
    return false
  }

  private definedInDescendant(token: Token<any>): boolean {
    for (const child of this.children) {
      if (child.definitions.has(token) || child.definedInDescendant(token)) {
        return true
      }
    }
    return false
  }

  private markUnloadingDeep(token: Token<any>): void {
    this.unloading.add(token)
    for (const child of this.children) child.markUnloadingDeep(token)
  }

  private unmarkUnloadingDeep(token: Token<any>): void {
    this.unloading.delete(token)
    for (const child of this.children) child.unmarkUnloadingDeep(token)
  }

  private checkCircularDependency(token: Token<any>, chain: ResolutionFrame[]): void {
    if (chain.some((frame) => frame.token === token)) {
      throw new CircularDependencyError([...chain.map((f) => f.token), token].map(tokenName))
    }
  }

  private checkCaptiveDependency(definition: Definition<any>, token: Token<any>, chain: ResolutionFrame[]): void {
    if (definition.lifetime !== Lifetimes.Scoped) return
    const singletonAncestor = chain.find((f) => f.lifetime === Lifetimes.Singleton)
    if (singletonAncestor) {
      throw new CaptiveDependencyError(tokenName(singletonAncestor.token), tokenName(token))
    }
  }

  // ── Eviction (unload) ─────────────────────────────────────────────────

  private hasCachedInstance(token: Token<any>): boolean {
    return (
      this.singletonInstances.has(token) ||
      this.scopedInstances.has(token) ||
      this.singletonResolutionPromises.has(token) ||
      this.scopedResolutionPromises.has(token) ||
      this.factoryResolutionPromises.has(token)
    )
  }

  private hasCachedInstanceDeep(token: Token<any>): boolean {
    if (this.hasCachedInstance(token)) return true
    for (const child of this.children) {
      if (child.hasCachedInstanceDeep(token)) return true
    }
    return false
  }

  // Evict a set of tokens from THIS container, disposing affected instances in
  // reverse creation order (dependents before dependencies), matching dispose().
  private async evictTokensLocal(tokens: Set<Token<any>>, errors: unknown[]): Promise<void> {
    const affected = new Set<Disposable>()

    for (const token of tokens) {
      for (const map of [this.singletonInstances, this.scopedInstances]) {
        const instance = map.get(token)
        map.delete(token) // remove cache entry even if disposal later throws
        if (isDisposable(instance)) affected.add(instance)
      }
      // Orphan any in-flight resolution: removing from the promise map makes
      // its identity guard fail, so it disposes its own result.
      const p1 = this.singletonResolutionPromises.get(token)
      const p2 = this.scopedResolutionPromises.get(token)
      this.singletonResolutionPromises.delete(token)
      this.scopedResolutionPromises.delete(token)
      const factorySet = this.factoryResolutionPromises.get(token)
      const factoryPromises = factorySet ? [...factorySet] : []
      for (const p of [p1, p2, ...factoryPromises]) {
        if (p) {
          try {
            await p
          } catch {
            /* orphaned resolution rejection is expected */
          }
        }
      }
    }

    // Dispose in reverse creation order, filtered to the affected instances.
    for (let i = this.disposables.length - 1; i >= 0; i--) {
      const disposable = this.disposables[i]
      if (disposable === undefined || !affected.has(disposable)) continue
      this.removeDisposable(disposable)
      try {
        await disposable.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
  }

  private async evictTokensDeep(tokens: Set<Token<any>>, errors: unknown[]): Promise<void> {
    for (const child of [...this.children]) {
      await child.evictTokensDeep(tokens, errors)
    }
    await this.evictTokensLocal(tokens, errors)
  }

  // ── Disposal ──────────────────────────────────────────────────────────

  // TODO: check
  private trackDisposable(value: unknown): void {
    if (isDisposable(value) && !this.disposableSet.has(value)) {
      this.disposableSet.add(value)
      this.disposables.push(value)
    }
  }

  private removeDisposable(value: Disposable): void {
    if (this.disposableSet.delete(value)) {
      const index = this.disposables.indexOf(value)
      if (index >= 0) this.disposables.splice(index, 1)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    // Acquire the tree-wide lock so dispose can't interleave with a load/unload
    // anywhere in the tree. Cascade disposal uses disposeInternal (no re-lock).
    const lock = this.beginTreeLifecycle()
    try {
      if (this.disposed) return // re-check under lock
      await this.disposeInternal()
    } finally {
      this.endTreeLifecycle(lock)
    }
  }

  private async disposeInternal(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    const errors: unknown[] = []

    for (const child of [...this.children]) {
      try {
        await child.disposeInternal()
      } catch (error) {
        errors.push(error)
      }
    }
    this.children.clear()

    // Await in-flight resolutions; their guards see disposed === true and
    // dispose the orphaned result before this call returns.
    const factoryPending = [...this.factoryResolutionPromises.values()].flatMap((s) => [...s])
    const pending = [
      ...this.singletonResolutionPromises.values(),
      ...this.scopedResolutionPromises.values(),
      ...factoryPending,
    ]
    for (const p of pending) {
      try {
        await p
      } catch {
        /* orphaned resolution */
      }
    }
    this.singletonResolutionPromises.clear()
    this.scopedResolutionPromises.clear()
    this.factoryResolutionPromises.clear()

    for (let i = this.disposables.length - 1; i >= 0; i--) {
      const disposable = this.disposables[i]
      if (disposable === undefined) continue
      try {
        await disposable.dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    this.disposables = []
    this.disposableSet.clear()
    this.singletonInstances.clear()
    this.scopedInstances.clear()

    this.parent?.children.delete(this)

    if (errors.length > 0) {
      throw new AggregateError(flattenErrors(errors), "One or more disposables failed to dispose")
    }
  }
}