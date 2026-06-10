import type { AnyToken } from "../token";
import type { Disposer } from "../types";

interface TrackedDisposable<T> {
  token: AnyToken<T>;
  instance: T;
  dispose: Disposer<T>;
}

/** Ordered registry of instances with a registered disposer. Only definitions
 *  that declare { dispose } are ever tracked — there is no duck-typing.
 *  Records are keyed by token, so evicting one token never runs another
 *  token's disposer, even when both cache the same object (aliases). */
export class DisposableRegistry {
  private items: TrackedDisposable<any>[] = [];

  track<T>(token: AnyToken<T>, instance: T, dispose: Disposer<T>): void {
    this.items.push({ token, instance, dispose });
  }

  async disposeReverse({
    targets,
    onError,
  }: {
    targets?: ReadonlySet<AnyToken<any>>;
    onError: (error: unknown) => void;
  }): Promise<void> {
    const toDispose: TrackedDisposable<any>[] = [];
    const remaining: TrackedDisposable<any>[] = [];
    for (const item of this.items) {
      // No targets means "dispose everything" (container teardown); a targets
      // set limits disposal to evicted tokens (module unload).
      (!targets || targets.has(item.token) ? toDispose : remaining).push(item);
    }

    // Swap in the kept items BEFORE awaiting any disposer, so an instance
    // tracked while a disposer runs lands in the live array instead of being
    // dropped by a reassignment after the loop.
    this.items = remaining;

    for (const item of toDispose.reverse()) {
      try {
        await item.dispose(item.instance);
      } catch (error) {
        onError(error);
      }
    }
  }
}
