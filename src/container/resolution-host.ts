import type { AnyToken } from "../token";
import type { AsyncDefinition, Disposer, ResolutionFrame } from "../types";

export interface ResolutionHost {
  isTreeDisposed(): boolean;
  isUnloading(token: AnyToken<any>): boolean;
  trackDisposable<T>(token: AnyToken<T>, instance: T, dispose: Disposer<T>): void;
  notifyDisposeError(error: unknown): void;
  wrapProviderError(token: AnyToken<any>, error: unknown): unknown;
  invokeProviderAsync<T>(definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T>;
}
