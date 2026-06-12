/** Base class for all framework-raised errors. */
export class DIError extends Error {}

export class MissingDependencyError extends DIError {
  constructor(name: string) {
    super(`No provider found for token: ${name}`);
    this.name = "MissingDependencyError";
  }
}

export class CircularDependencyError extends DIError {
  constructor(chain: string[]) {
    super(`Circular dependency detected:\n${chain.join(" -> ")}`);
    this.name = "CircularDependencyError";
  }
}

export class CaptiveDependencyError extends DIError {
  constructor(singleton: string, scoped: string) {
    super(
      `Captive dependency detected: singleton '${singleton}' depends on scoped '${scoped}'. ` +
        `A singleton cannot capture a scoped dependency (it would outlive its scope).`,
    );
    this.name = "CaptiveDependencyError";
  }
}

export class AsyncProviderError extends DIError {
  constructor(name: string) {
    super(`Provider for token '${name}' is asynchronous. Use getAsync() instead of get().`);
    this.name = "AsyncProviderError";
  }
}

export class SyncProviderError extends DIError {
  constructor(name: string) {
    super(`Provider for token '${name}' is synchronous. Use get() instead of getAsync().`);
    this.name = "SyncProviderError";
  }
}

export class DisposedContainerError extends DIError {
  constructor() {
    super("Container has been disposed and can no longer be used.");
    this.name = "DisposedContainerError";
  }
}

export class DuplicateDefinitionError extends DIError {
  constructor(name: string) {
    super(`Definition already exists for token '${name}'. Load with { override: true } to replace it.`);
    this.name = "DuplicateDefinitionError";
  }
}

export class DefinitionInUseError extends DIError {
  constructor(name: string) {
    super(
      `Cannot override token '${name}': it already has a resolved or in-flight instance. ` +
        `Unload it first, then load the replacement.`,
    );
    this.name = "DefinitionInUseError";
  }
}

export class DependentInstanceError extends DIError {
  constructor(dependents: string[]) {
    super(
      `Cannot unload: live instance(s) of ${dependents.map((d) => `'${d}'`).join(", ")} depend on the module's definitions. ` +
        `Dispose or unload the dependents first.`,
    );
    this.name = "DependentInstanceError";
  }
}

export class ModuleOwnershipError extends DIError {
  constructor(name: string) {
    super(`Cannot unload token '${name}': it was not loaded by this module on this container.`);
    this.name = "ModuleOwnershipError";
  }
}

export class ProviderExecutionError extends DIError {
  override readonly cause: unknown;
  constructor(name: string, cause: unknown) {
    super(`Provider for token '${name}' threw during construction.`);
    this.name = "ProviderExecutionError";
    this.cause = cause;
  }
}

/** Any error raised by the framework itself — never wrapped as a provider error. */
export function isFrameworkError(error: unknown): boolean {
  return error instanceof DIError;
}

export class ShadowedDefinitionError extends DIError {
  constructor(name: string) {
    super(
      `Token '${name}' is already defined elsewhere in the container tree. ` +
        `Ancestor and descendant containers cannot define the same token.`,
    );
    this.name = "ShadowedDefinitionError";
  }
}

export class LifecycleOperationError extends DIError {
  constructor() {
    super("A container lifecycle operation (load/unload/dispose) is already in progress.");
    this.name = "LifecycleOperationError";
  }
}

export class InvalidModuleNameError extends DIError {
  constructor(name: string) {
    super(
      `Module name '${name}' must be PascalCase (an identifier starting with an uppercase letter); ` +
        `the container view's lowercase API can then never collide with a module namespace.`,
    );
    this.name = "InvalidModuleNameError";
  }
}

export class InvalidEntryNameError extends DIError {
  constructor(entry: string, module: string) {
    super(`Entry name '${entry}' in module '${module}' must be a valid identifier (dot-accessible).`);
    this.name = "InvalidEntryNameError";
  }
}

export class DuplicateEntryNameError extends DIError {
  constructor(entry: string, module: string) {
    super(`Duplicate accessor name '${entry}' in module '${module}'.`);
    this.name = "DuplicateEntryNameError";
  }
}

export class InvalidModuleUseError extends DIError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModuleUseError";
  }
}

export class ForeignModuleError extends DIError {
  constructor() {
    super("Value is not a module created by createModule().");
    this.name = "ForeignModuleError";
  }
}

export class DuplicateModuleNameError extends DIError {
  constructor(name: string) {
    super(`Duplicate module name '${name}' in container.`);
    this.name = "DuplicateModuleNameError";
  }
}
