import { LifecycleOperationError } from "../errors";

/** Tree-wide lifecycle coordination. load/unload change the
 *  tree's structure, so each is exclusive against every other lifecycle
 *  operation. A disposal only tears down its own subtree, so any number may run
 *  at once — overlapping subtrees coordinate by joining each other's disposal,
 *  not through this lock. */
export class LifecycleLock {
  private structuralChangeInProgress = false;
  private activeDisposalCount = 0;

  acquireStructuralChange(): void {
    if (this.structuralChangeInProgress || this.activeDisposalCount > 0) throw new LifecycleOperationError();
    this.structuralChangeInProgress = true;
  }

  releaseStructuralChange(): void {
    this.structuralChangeInProgress = false;
  }

  acquireDisposal(): void {
    if (this.structuralChangeInProgress) throw new LifecycleOperationError();
    this.activeDisposalCount += 1;
  }

  releaseDisposal(): void {
    this.activeDisposalCount -= 1;
  }
}
