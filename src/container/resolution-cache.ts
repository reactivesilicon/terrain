import { DisposedContainerError } from "../errors";
import type { AnyToken, AsyncToken, Token } from "../token";
import type { AsyncDefinition, Disposable, ResolutionFrame } from "../types";
import { isDisposable } from "../utils";
import type { ResolutionHost } from "./resolution-host";

export const InstanceKinds = {
  Singleton: "singleton",
  Scoped: "scoped",
} as const;
export type InstanceKind = (typeof InstanceKinds)[keyof typeof InstanceKinds];

// Owns instance + in-flight resolution storage AND the consistency rules over
// them: coalescing, the commit guard (tree torn down / token unloaded / a newer
// resolution won), atomic promotion of a resolved promise into the instance
// cache, and orphan disposal on a lost commit. Tree/lifecycle/provider concerns
// are delegated to the ResolutionHost.
export class ResolutionCache {
  private singletonInstances = new Map<AnyToken<any>, any>();
  private scopedInstances = new Map<AnyToken<any>, any>();
  private singletonResolutionPromises = new Map<AnyToken<any>, Promise<any>>();
  private scopedResolutionPromises = new Map<AnyToken<any>, Promise<any>>();
  private factoryResolutionPromises = new Map<AnyToken<any>, Set<Promise<any>>>();

  constructor(private readonly host: ResolutionHost) {}

  // ── sync instance access (used by Container's sync resolvers) ──

  getSyncInstance<T>(kind: InstanceKind, token: Token<T>): { has: true; value: T } | { has: false } {
    const map = this.instances(kind);
    if (!map.has(token)) return { has: false };
    return { has: true, value: map.get(token) };
  }

  commitSyncInstance<T>(kind: InstanceKind, token: Token<T>, instance: T): void {
    this.instances(kind).set(token, instance);
    this.host.trackDisposable(instance);
  }

  // ── async cached resolution (singleton/scoped) ──

  async resolveCachedAsync<T>(
    kind: InstanceKind,
    token: AsyncToken<T>,
    definition: AsyncDefinition<T>,
    chain: ResolutionFrame[],
  ): Promise<T> {
    const instances = this.instances(kind);
    const resolutionPromises = this.resolutionPromises(kind);

    if (instances.has(token)) return instances.get(token);
    const pendingTokenResolutionPromise = resolutionPromises.get(token);
    if (pendingTokenResolutionPromise) return pendingTokenResolutionPromise;

    let promise: Promise<T>;
    promise = this.guard({
      token: token,
      build: () => this.host.invokeProviderAsync(definition, chain),
      isStale: () => resolutionPromises.get(token) !== promise,
    });
    resolutionPromises.set(token, promise);

    const settledResolution = await promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    if (settledResolution.ok) {
      instances.set(token, settledResolution.value);
      this.host.trackDisposable(settledResolution.value);
      resolutionPromises.delete(token);
      return settledResolution.value;
    }
    if (resolutionPromises.get(token) === promise) resolutionPromises.delete(token);
    throw settledResolution.error;
  }

  // ── async factory resolution (no caching, tracked for teardown) ──

  async resolveFactoryAsync<T>(definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T> {
    const token = definition.token;
    let pendingTokenResolutionPromises = this.factoryResolutionPromises.get(token);
    if (!pendingTokenResolutionPromises) {
      pendingTokenResolutionPromises = new Set();
      this.factoryResolutionPromises.set(token, pendingTokenResolutionPromises);
    }

    const promise = this.guard({
      token: token,
      build: () => this.host.invokeProviderAsync(definition, chain),
      isStale: () => false,
    });
    pendingTokenResolutionPromises.add(promise);

    const settledResolution = await promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    this.removeFactoryPromise(token, promise);

    if (settledResolution.ok) return settledResolution.value;
    throw settledResolution.error;
  }

  private removeFactoryPromise(token: AsyncToken<any>, promise: Promise<unknown>): void {
    const pendingTokenResolutionPromises = this.factoryResolutionPromises.get(token);
    if (!pendingTokenResolutionPromises) return;
    pendingTokenResolutionPromises.delete(promise);
    if (pendingTokenResolutionPromises.size === 0) this.factoryResolutionPromises.delete(token);
  }

  /**
   * Guards a cache-writing async resolution: runs the build, then refuses to commit if the tree was torn down / token unloaded / a newer resolution won.
   * */
  private async guard<T>({
    token,
    build,
    isStale,
  }: {
    token: AsyncToken<any>;
    build: () => Promise<T>;
    isStale: () => boolean;
  }): Promise<T> {
    let instance: T;
    try {
      instance = await build();
    } catch (error) {
      throw this.host.wrapProviderError(token, error);
    }
    if (this.host.isTreeDisposed() || this.host.isUnloading(token) || isStale()) {
      await this.disposeOrphan(instance);
      throw new DisposedContainerError();
    }
    return instance;
  }

  private async disposeOrphan(instance: unknown): Promise<void> {
    if (!isDisposable(instance)) return;
    try {
      await instance.dispose();
    } catch (error) {
      this.host.notifyDisposeError(error);
    }
  }

  // ── teardown / introspection (used by Container.evict & dispose) ──

  hasCached(token: AnyToken<any>): boolean {
    return (
      this.singletonInstances.has(token) ||
      this.scopedInstances.has(token) ||
      this.singletonResolutionPromises.has(token) ||
      this.scopedResolutionPromises.has(token) ||
      this.factoryResolutionPromises.has(token)
    );
  }

  // Remove a token's cached instances, returning any disposables to be disposed
  // by the caller (in its own reverse-creation order).
  evictInstances(token: AnyToken<any>): Disposable[] {
    const out: Disposable[] = [];
    for (const map of [this.singletonInstances, this.scopedInstances]) {
      const instance = map.get(token);
      map.delete(token);
      if (isDisposable(instance)) out.push(instance);
    }
    return out;
  }

  // In-flight promises for a token (all kinds), for the caller to await/orphan.
  pendingForToken(token: AnyToken<any>): Promise<unknown>[] {
    const factory = this.factoryResolutionPromises.get(token);
    return [
      this.singletonResolutionPromises.get(token),
      this.scopedResolutionPromises.get(token),
      ...(factory ? [...factory] : []),
    ].filter((p): p is Promise<unknown> => p !== undefined);
  }

  deletePromisesForToken(token: AnyToken<any>): void {
    this.singletonResolutionPromises.delete(token);
    this.scopedResolutionPromises.delete(token);
    this.factoryResolutionPromises.delete(token);
  }

  allPendingResolutionPromises(): Promise<unknown>[] {
    const factory = [...this.factoryResolutionPromises.values()].flatMap((s) => [...s]);
    return [...this.singletonResolutionPromises.values(), ...this.scopedResolutionPromises.values(), ...factory];
  }

  clearResolutionPromises(): void {
    this.singletonResolutionPromises.clear();
    this.scopedResolutionPromises.clear();
    this.factoryResolutionPromises.clear();
  }

  clearInstances(): void {
    this.singletonInstances.clear();
    this.scopedInstances.clear();
  }

  private instances(kind: InstanceKind): Map<AnyToken<any>, any> {
    switch (kind) {
      case InstanceKinds.Singleton:
        return this.singletonInstances;
      case InstanceKinds.Scoped:
        return this.scopedInstances;
      default: {
        throw new Error(`Unknown instance kind: ${String(kind)}`);
      }
    }
  }

  private resolutionPromises(kind: InstanceKind): Map<AnyToken<any>, Promise<any>> {
    switch (kind) {
      case InstanceKinds.Singleton:
        return this.singletonResolutionPromises;
      case InstanceKinds.Scoped:
        return this.scopedResolutionPromises;
      default: {
        throw new Error(`Unknown instance kind: ${String(kind)}`);
      }
    }
  }
}
