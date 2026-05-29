import {
  AsyncProviderError,
  CaptiveDependencyError,
  CircularDependencyError,
  DefinitionInUseError,
  DisposedContainerError,
  DuplicateDefinitionError,
  LifecycleOperationError,
  MissingDependencyError,
  ModuleOwnershipError,
  ProviderExecutionError,
  ShadowedDefinitionError,
  isFrameworkError,
} from "./errors"

import type {
  AsyncProvider,
  AsyncResolver,
  ContainerOptions,
  Definition,
  Disposable,
  Lifetime,
  LoadOptions,
  SyncProvider,
  SyncResolver,
} from "./types"

import type { Token } from "./token"

import type { Module } from "./module"

function tokenName(token: symbol): string {
  return token.description || "UnknownToken"
}

function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof (value as Disposable).dispose === "function"
  )
}

function isThenable(value: unknown): value is Promise<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === "function"
}

/** Flatten nested AggregateErrors into a single list of leaf errors. */
function flattenErrors(errors: unknown[]): unknown[] {
  const out: unknown[] = []
  for (const error of errors) {
    if (error instanceof AggregateError) out.push(...flattenErrors(error.errors))
    else out.push(error)
  }
  return out
}

interface ResolutionFrame {
  token: Token<any>
  lifetime: Lifetime
}

interface Owned<T> {
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

  private singletons = new Map<Token<any>, any>()
  private singletonPromises = new Map<Token<any>, Promise<any>>()
  private scopedInstances = new Map<Token<any>, any>()
  private scopedPromises = new Map<Token<any>, Promise<any>>()
  // In-flight async factory resolutions, grouped by token. Factories are
  // caller-owned once built, but tracking lets teardown await/orphan them.
  private factoryPromises = new Map<Token<any>, Set<Promise<any>>>()

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

  private assertNotDisposed(): void {
    if (this.disposed) throw new DisposedContainerError()
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
    const { definition, owner } = found

    this.checkCircular(token, chain)
    this.checkCaptive(definition, token, chain)
    if (definition.async) throw new AsyncProviderError(tokenName(token))

    const next = this.extend(chain, token, definition.lifetime)
    switch (definition.lifetime) {
      case "singleton":
        return owner.resolveSingletonSync(token, definition, next)
      case "scoped":
        return this.resolveScopedSync(token, definition, next)
      case "factory":
        return this.resolveFactorySync(definition, next)
      default: {
        const _exhaustive: never = definition.lifetime
        throw new Error(`Unknown lifetime: ${String(_exhaustive)}`)
      }
    }
  }

  private resolveSingletonSync<T>(token: Token<T>, definition: Definition<T>, chain: ResolutionFrame[]): T {
    if (this.singletons.has(token)) return this.singletons.get(token)
    const instance = this.ensureSync(this.invokeProvider(definition, chain), token)
    this.guardAfterConstruction(token, instance)
    this.singletons.set(token, instance)
    this.trackDisposable(instance)
    return instance
  }

  private resolveScopedSync<T>(token: Token<T>, definition: Definition<T>, chain: ResolutionFrame[]): T {
    if (this.scopedInstances.has(token)) return this.scopedInstances.get(token)
    const instance = this.ensureSync(this.invokeProvider(definition, chain), token)
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

  private resolveFactorySync<T>(definition: Definition<T>, chain: ResolutionFrame[]): T {
    const instance = this.ensureSync(this.invokeProvider(definition, chain), definition.token)
    this.guardAfterConstruction(definition.token, instance)
    return instance
  }

  // ── Async resolution ──────────────────────────────────────────────────

  private async resolveAsync<T>(token: Token<T>, chain: ResolutionFrame[]): Promise<T> {
    this.assertTreeUsable()

    const found = this.findOwner(token)
    if (!found) throw new MissingDependencyError(tokenName(token))
    const { definition, owner } = found

    this.checkCircular(token, chain)
    this.checkCaptive(definition, token, chain)

    const next = this.extend(chain, token, definition.lifetime)
    switch (definition.lifetime) {
      case "singleton":
        return owner.resolveSingletonAsync(token, definition, next)
      case "scoped":
        return this.resolveScopedAsync(token, definition, next)
      case "factory":
        return this.resolveFactoryAsync(definition, next)
      default: {
        const _exhaustive: never = definition.lifetime
        throw new Error(`Unknown lifetime: ${String(_exhaustive)}`)
      }
    }
  }

  private resolveSingletonAsync<T>(token: Token<T>, definition: Definition<T>, chain: ResolutionFrame[]): Promise<T> {
    if (this.singletons.has(token)) return Promise.resolve(this.singletons.get(token))
    const pending = this.singletonPromises.get(token)
    if (pending) return pending

    let promise: Promise<T>
    promise = Promise.resolve()
      .then(() => this.invokeProvider(definition, chain) as T | Promise<T>)
      .then(async (instance: T) => {
        if (this.isTreeDisposed() || this.unloading.has(token) || this.singletonPromises.get(token) !== promise) {
          await this.disposeOrphan(instance)
          throw new DisposedContainerError()
        }
        this.singletons.set(token, instance)
        this.trackDisposable(instance)
        this.singletonPromises.delete(token)
        return instance
      })
      .catch((error: unknown) => {
        if (this.singletonPromises.get(token) === promise) this.singletonPromises.delete(token)
        throw this.wrapProviderError(token, error)
      })

    this.singletonPromises.set(token, promise)
    return promise
  }

  private resolveScopedAsync<T>(token: Token<T>, definition: Definition<T>, chain: ResolutionFrame[]): Promise<T> {
    if (this.scopedInstances.has(token)) return Promise.resolve(this.scopedInstances.get(token))
    const pending = this.scopedPromises.get(token)
    if (pending) return pending

    let promise: Promise<T>
    promise = Promise.resolve()
      .then(() => this.invokeProvider(definition, chain) as T | Promise<T>)
      .then(async (instance: T) => {
        if (this.isTreeDisposed() || this.unloading.has(token) || this.scopedPromises.get(token) !== promise) {
          await this.disposeOrphan(instance)
          throw new DisposedContainerError()
        }
        this.scopedInstances.set(token, instance)
        this.trackDisposable(instance)
        this.scopedPromises.delete(token)
        return instance
      })
      .catch((error: unknown) => {
        if (this.scopedPromises.get(token) === promise) this.scopedPromises.delete(token)
        throw this.wrapProviderError(token, error)
      })

    this.scopedPromises.set(token, promise)
    return promise
  }

  private resolveFactoryAsync<T>(definition: Definition<T>, chain: ResolutionFrame[]): Promise<T> {
    const token = definition.token
    let set = this.factoryPromises.get(token)
    if (!set) {
      set = new Set()
      this.factoryPromises.set(token, set)
    }

    let promise: Promise<T>
    promise = Promise.resolve()
      .then(() => this.invokeProvider(definition, chain) as T | Promise<T>)
      .then(async (instance: T) => {
        // Factory results are caller-owned, but a container torn down during
        // construction must not finish handing out a new object.
        if (this.isTreeDisposed() || this.unloading.has(token)) {
          await this.disposeOrphan(instance)
          throw new DisposedContainerError()
        }
        return instance
      })
      .catch((error: unknown) => {
        throw this.wrapProviderError(token, error)
      })
      .finally(() => {
        const s = this.factoryPromises.get(token)
        if (s) {
          s.delete(promise)
          if (s.size === 0) this.factoryPromises.delete(token)
        }
      })

    set.add(promise)
    return promise
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

  private invokeProvider<T>(definition: Definition<T>, chain: ResolutionFrame[]): T | Promise<T> {
    try {
      if (definition.async) {
        return (definition.provider as AsyncProvider<T>)(this.makeAsyncResolver(chain))
      }
      return (definition.provider as SyncProvider<T>)(this.makeSyncResolver(chain))
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
    return [...chain, { token, lifetime }]
  }

  private findOwner<T>(token: Token<T>): Owned<T> | undefined {
    // Never resolve through a disposed container (defensive: also covers a
    // child left alive past an ancestor's disposal by some future bug).
    if (this.disposed) return undefined
    const local = this.definitions.get(token) as Definition<T> | undefined
    if (local) {
      // A token mid-unload is treated as absent so an in-flight provider that
      // resumes during unload cannot re-create/re-cache it.
      if (this.unloading.has(token)) return undefined
      return { definition: local, owner: this }
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

  private checkCircular(token: Token<any>, chain: ResolutionFrame[]): void {
    if (chain.some((frame) => frame.token === token)) {
      throw new CircularDependencyError([...chain.map((f) => f.token), token].map(tokenName))
    }
  }

  private checkCaptive(definition: Definition<any>, token: Token<any>, chain: ResolutionFrame[]): void {
    if (definition.lifetime !== "scoped") return
    const singletonAncestor = chain.find((f) => f.lifetime === "singleton")
    if (singletonAncestor) {
      throw new CaptiveDependencyError(tokenName(singletonAncestor.token), tokenName(token))
    }
  }

  private ensureSync<T>(value: T | Promise<T>, token: Token<any>): T {
    if (isThenable(value)) throw new AsyncProviderError(tokenName(token))
    return value as T
  }

  // ── Eviction (unload) ─────────────────────────────────────────────────

  private hasCachedInstance(token: Token<any>): boolean {
    return (
      this.singletons.has(token) ||
      this.scopedInstances.has(token) ||
      this.singletonPromises.has(token) ||
      this.scopedPromises.has(token) ||
      this.factoryPromises.has(token)
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
      for (const map of [this.singletons, this.scopedInstances]) {
        const instance = map.get(token)
        map.delete(token) // remove cache entry even if disposal later throws
        if (isDisposable(instance)) affected.add(instance)
      }
      // Orphan any in-flight resolution: removing from the promise map makes
      // its identity guard fail, so it disposes its own result.
      const p1 = this.singletonPromises.get(token)
      const p2 = this.scopedPromises.get(token)
      this.singletonPromises.delete(token)
      this.scopedPromises.delete(token)
      const factorySet = this.factoryPromises.get(token)
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
      if (!affected.has(disposable)) continue
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
    const factoryPending = [...this.factoryPromises.values()].flatMap((s) => [...s])
    const pending = [
      ...this.singletonPromises.values(),
      ...this.scopedPromises.values(),
      ...factoryPending,
    ]
    for (const p of pending) {
      try {
        await p
      } catch {
        /* orphaned resolution */
      }
    }
    this.singletonPromises.clear()
    this.scopedPromises.clear()
    this.factoryPromises.clear()

    for (let i = this.disposables.length - 1; i >= 0; i--) {
      try {
        await this.disposables[i].dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    this.disposables = []
    this.disposableSet.clear()
    this.singletons.clear()
    this.scopedInstances.clear()

    this.parent?.children.delete(this)

    if (errors.length > 0) {
      throw new AggregateError(flattenErrors(errors), "One or more disposables failed to dispose")
    }
  }
}