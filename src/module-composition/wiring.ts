/** The given modules and every module they use, transitively — each included
 *  once. Dedup is by module identity, so two modules sharing a dependency
 *  (or a version diamond) wire it a single time. */
export function wiringOf<Module extends { readonly usedModules: readonly Module[] }>(
  roots: readonly Module[],
): Set<Module> {
  const wiring = new Set<Module>();
  const visit = (modules: readonly Module[]): void => {
    for (const module of modules) {
      if (wiring.has(module)) continue;
      visit(module.usedModules);
      wiring.add(module);
    }
  };
  visit(roots);
  return wiring;
}
