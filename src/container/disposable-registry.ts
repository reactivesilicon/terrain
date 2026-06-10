import type { Disposer } from "../types";

interface TrackedDisposable<T> {
  instance: T;
  dispose: Disposer<T>;
}

/** Ordered registry of instances with a registered disposer. Only definitions
 *  that declare { dispose } are ever tracked — there is no duck-typing. */
export class DisposableRegistry {
  private items: TrackedDisposable<any>[] = [];

  track<T>(instance: T, dispose: Disposer<T>): void {
    this.items.push({ instance, dispose });
  }

  async disposeReverse({
    targets,
    onError,
  }: {
    targets?: ReadonlySet<unknown>;
    onError: (error: unknown) => void;
  }): Promise<void> {
    const toDispose: TrackedDisposable<any>[] = [];
    const remaining: TrackedDisposable<any>[] = [];
    for (const item of this.items) {
      // No targets means "dispose everything" (container teardown); a targets
      // set limits disposal to evicted instances (module unload).
      (!targets || targets.has(item.instance) ? toDispose : remaining).push(item);
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
