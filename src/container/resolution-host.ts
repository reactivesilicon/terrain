import type { Token } from "../token"
import type {AsyncDefinition, ResolutionFrame, SyncDefinition} from "../types"

export interface ResolutionHost {
  isTreeDisposed(): boolean
  isUnloading(token: Token<any>): boolean
  trackDisposable(instance: unknown): void
  notifyDisposeError(error: unknown): void
  wrapProviderError(token: Token<any>, error: unknown): unknown
  invokeProviderSync<T>(definition: SyncDefinition<T>, chain: ResolutionFrame[]): T
  invokeProviderAsync<T>(definition: AsyncDefinition<T>, chain: ResolutionFrame[]): Promise<T>
}