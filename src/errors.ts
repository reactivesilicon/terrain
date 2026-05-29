/** Base class for all framework-raised errors. */
export class DIError extends Error {}

export class MissingDependencyError extends DIError {
  constructor(name: string) {
    super(`No provider found for token: ${name}`)
    this.name = "MissingDependencyError"
  }
}

export class CircularDependencyError extends DIError {
  constructor(chain: string[]) {
    super(`Circular dependency detected:\n${chain.join(" -> ")}`)
    this.name = "CircularDependencyError"
  }
}

export class CaptiveDependencyError extends DIError {
  constructor(singleton: string, scoped: string) {
    super(
      `Captive dependency detected: singleton '${singleton}' depends on scoped '${scoped}'. ` +
      `A singleton cannot capture a scoped dependency (it would outlive its scope).`,
    )
    this.name = "CaptiveDependencyError"
  }
}

export class AsyncProviderError extends DIError {
  constructor(name: string) {
    super(`Provider for token '${name}' is asynchronous. Use getAsync() instead of get().`)
    this.name = "AsyncProviderError"
  }
}

export class DisposedContainerError extends DIError {
  constructor() {
    super("Container has been disposed and can no longer be used.")
    this.name = "DisposedContainerError"
  }
}

export class DuplicateDefinitionError extends DIError {
  constructor(name: string) {
    super(`Definition already exists for token '${name}'. Load with { override: true } to replace it.`)
    this.name = "DuplicateDefinitionError"
  }
}

export class DefinitionInUseError extends DIError {
  constructor(name: string) {
    super(
      `Cannot override token '${name}': it already has a resolved or in-flight instance. ` +
      `Unload it first, then load the replacement.`,
    )
    this.name = "DefinitionInUseError"
  }
}

export class ModuleOwnershipError extends DIError {
  constructor(name: string) {
    super(`Cannot unload token '${name}': it is not owned by this container.`)
    this.name = "ModuleOwnershipError"
  }
}

export class ProviderExecutionError extends DIError {
  readonly cause: unknown
  constructor(name: string, cause: unknown) {
    super(`Provider for token '${name}' threw during construction.`)
    this.name = "ProviderExecutionError"
    this.cause = cause
  }
}

/** Any error raised by the framework itself — never wrapped as a provider error. */
export function isFrameworkError(error: unknown): boolean {
  return error instanceof DIError
}

export class ShadowedDefinitionError extends DIError {
  constructor(name: string) {
    super(
      `Token '${name}' is already defined elsewhere in the container tree. ` +
      `Ancestor and descendant containers cannot define the same token.`,
    )
    this.name = "ShadowedDefinitionError"
  }
}

export class LifecycleOperationError extends DIError {
  constructor() {
    super("A container lifecycle operation (load/unload/dispose) is already in progress.")
    this.name = "LifecycleOperationError"
  }
}