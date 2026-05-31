import type { Disposable } from "../types";
import { isDisposable } from "../utils";

export class DisposableRegistry {
  private items = new Set<Disposable>();

  track(value: unknown): void {
    if (isDisposable(value)) this.items.add(value);
  }

  async disposeReverse({
    targets,
    onError,
  }: {
    targets?: Set<Disposable>;
    onError: (error: unknown) => void;
  }): Promise<void> {
    const list = [...this.items].reverse();
    for (const disposable of list) {
      if (targets && !targets.has(disposable)) continue;
      this.items.delete(disposable);
      try {
        await disposable.dispose();
      } catch (error) {
        onError(error);
      }
    }
  }
}
