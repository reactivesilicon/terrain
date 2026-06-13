import { InvalidModuleUseError } from "../errors";

/** The given modules and every module they use, transitively — each included
 *  once. Dedup is by module identity, so two modules sharing a dependency
 *  (or a version diamond) wire it a single time. */
export function wiringOf<Module extends { readonly uses: readonly Module[] }>(roots: readonly Module[]): Set<Module> {
  const wiring = new Set<Module>();
  const visit = (modules: readonly Module[]): void => {
    for (const module of modules) {
      if (wiring.has(module)) continue;
      visit(module.uses);
      wiring.add(module);
    }
  };
  visit(roots);
  return wiring;
}

/** Resolver namespaces are keyed by module name: a module's own name and the
 *  names of everything it uses must be pairwise distinct, or one namespace
 *  would silently shadow another. */
// TODO: export to validations
export function assertNoNamespaceCollisions(moduleName: string, uses: readonly { readonly name: string }[]): void {
  const seenNames = new Set<string>();
  for (const used of uses) {
    if (used.name === moduleName) {
      throw new InvalidModuleUseError(`Module '${moduleName}' cannot use a module bearing its own name.`);
    }
    if (seenNames.has(used.name)) {
      throw new InvalidModuleUseError(`Duplicate used module name '${used.name}' in module '${moduleName}'.`);
    }
    seenNames.add(used.name);
  }
}
