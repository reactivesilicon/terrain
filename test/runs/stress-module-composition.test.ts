import { describe, expect, it } from "vitest";

import { DIError } from "../../src";
import { createContainer, createModule, type ComposedModule } from "../../src/module-composition/composition";
import { delay, random } from "../helpers";

/**
 * Property/stress suite for the named layer: randomly generated module graphs
 * (entries with random lifetimes/modes/disposers, cross-module uses), then
 * random sequences of accessor calls, scope views, start(), and disposal.
 * Invariants mirror the engine fuzzer:
 *   1. a successful resolution never returns an already-disposed instance,
 *   2. no disposer ever runs twice,
 *   3. at teardown every cached instance with a disposer ran it exactly once,
 *   4. every thrown error is a framework error (DIError / AggregateError).
 */

interface Instance {
  id: number;
  disposeCount: number;
  deps: Instance[];
}

interface EntryRecord {
  moduleName: string;
  key: string;
  mode: "sync" | "async";
}

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function chance(probability: number): boolean {
  return random() < probability;
}

describe("stress: named layer random operations", () => {
  it("upholds the layer's invariants across random module graphs", { timeout: 60_000 }, async () => {
    const SEQUENCES = 10;
    const OPS_PER_SEQUENCE = 30;

    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      const violations: string[] = [];
      const opLog: string[] = [];
      const instances: { instance: Instance; cached: boolean; hasDisposer: boolean }[] = [];
      let nextInstanceId = 0;

      const assertNoViolations = (): void => {
        if (violations.length === 0) return;
        throw new Error(`sequence ${sequence}: ${violations.join("; ")}\nlast ops:\n${opLog.slice(-15).join("\n")}`);
      };

      const checkResolved = (value: Instance, op: string): void => {
        if (value.disposeCount > 0) violations.push(`${op} returned a disposed instance #${value.id}`);
      };
      const checkError = (e: unknown, op: string): void => {
        if (!(e instanceof DIError || e instanceof AggregateError)) {
          violations.push(`${op} threw a non-framework error: ${String(e)}`);
        }
      };

      // ── generate 2-4 modules, each possibly using earlier ones ──
      const builtModules: ComposedModule<string, never>[] = [];
      const catalog: EntryRecord[] = [];
      const moduleCount = 2 + Math.floor(random() * 3);

      for (let moduleIndex = 0; moduleIndex < moduleCount; moduleIndex += 1) {
        const moduleName = `M${sequence}x${moduleIndex}`;
        const uses = builtModules.filter(() => chance(0.5));
        const importable = catalog.filter((e) => uses.some((u) => (u as { name: string }).name === e.moduleName));
        const ownEntries: EntryRecord[] = [];
        const entryCount = 2 + Math.floor(random() * 4);

        const setup = (m: unknown) => {
          let builder = m as Record<string, (...args: never[]) => unknown>;
          for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
            const key = `e${entryIndex}`;
            const mode = chance(0.35) ? "async" : "sync";
            const lifetime = pick(["single", "single", "factory", "scoped"] as const);
            const cached = lifetime !== "factory";
            const hasDisposer = chance(0.6);
            // sync providers may only depend on sync entries
            const candidates = [...ownEntries, ...importable].filter((d) => mode === "async" || d.mode === "sync");
            const deps = candidates.filter(() => chance(0.3)).slice(0, 2);

            const construct = (resolved: Instance[]): Instance => {
              const instance: Instance = { id: nextInstanceId, disposeCount: 0, deps: resolved };
              nextInstanceId += 1;
              instances.push({ instance, cached, hasDisposer });
              return instance;
            };
            const options: Record<string, unknown> = {};
            if (hasDisposer) {
              options.dispose = (x: Instance) => {
                x.disposeCount += 1;
                if (x.disposeCount > 1) violations.push(`instance #${x.id} disposed ${x.disposeCount} times`);
              };
            }
            if (lifetime === "single" && chance(0.15)) options.eager = true;

            const method = `${lifetime}${mode === "async" ? "Async" : ""}`;
            const provider =
              mode === "async"
                ? async (r: Record<string, Record<string, () => unknown>>) => {
                    const resolved: Instance[] = [];
                    for (const dep of deps) {
                      const value = r[dep.moduleName]![dep.key]!();
                      resolved.push((dep.mode === "async" ? await value : value) as Instance);
                    }
                    await delay(random() * 2);
                    return construct(resolved);
                  }
                : (r: Record<string, Record<string, () => unknown>>) =>
                    construct(deps.map((dep) => r[dep.moduleName]![dep.key]!() as Instance));

            builder = builder[method]!(key as never, provider as never, options as never) as typeof builder;
            ownEntries.push({ moduleName, key, mode });
          }
          return builder;
        };

        const module =
          uses.length > 0
            ? (createModule as never as (n: string, c: unknown, s: unknown) => ComposedModule<string, never>)(
                moduleName,
                { uses },
                setup,
              )
            : (createModule as never as (n: string, s: unknown) => ComposedModule<string, never>)(moduleName, setup);
        builtModules.push(module);
        catalog.push(...ownEntries);
      }

      // ── random operations against the view ──
      const app = (createContainer as never as (config: { parts: ComposedModule<string, never>[] }) => unknown)({
        parts: builtModules,
      }) as {
        scope(): Record<string, Record<string, () => unknown>> & { dispose(): Promise<void> };
        start(): Promise<void>;
        dispose(): Promise<void>;
      } & Record<string, Record<string, () => unknown>>;

      const liveScopes: (typeof app extends { scope(): infer S } ? S : never)[] = [];

      for (let op = 0; op < OPS_PER_SEQUENCE; op += 1) {
        const roll = random();
        try {
          if (roll < 0.55) {
            const entry = pick(catalog);
            const view = liveScopes.length > 0 && chance(0.4) ? pick(liveScopes) : app;
            opLog.push(`#${op} resolve ${entry.moduleName}.${entry.key} (${entry.mode})`);
            const result = view[entry.moduleName]![entry.key]!();
            const value = (entry.mode === "async" ? await result : result) as Instance;
            checkResolved(value, `${entry.moduleName}.${entry.key}`);
          } else if (roll < 0.7) {
            opLog.push(`#${op} scope()`);
            liveScopes.push(app.scope());
          } else if (roll < 0.85 && liveScopes.length > 0) {
            const index = Math.floor(random() * liveScopes.length);
            opLog.push(`#${op} dispose scope ${index}`);
            await liveScopes.splice(index, 1)[0]!.dispose();
          } else if (roll < 0.95) {
            opLog.push(`#${op} start()`);
            await app.start();
          } else {
            opLog.push(`#${op} dispose app`);
            await app.dispose();
          }
        } catch (e) {
          checkError(e, opLog[opLog.length - 1] ?? "unknown");
        }
        assertNoViolations();
      }

      // ── teardown and leak audit ──
      for (const scope of liveScopes) {
        await scope.dispose().catch((e: unknown) => checkError(e, "scope teardown"));
      }
      await app.dispose().catch((e: unknown) => checkError(e, "final dispose"));
      await delay(5);

      for (const { instance, cached, hasDisposer } of instances) {
        if (!hasDisposer) continue;
        if (cached && instance.disposeCount !== 1) {
          violations.push(`cached instance #${instance.id} disposed ${instance.disposeCount} times (expected 1)`);
        }
        if (!cached && instance.disposeCount > 1) {
          violations.push(`factory instance #${instance.id} disposed ${instance.disposeCount} times`);
        }
      }
      assertNoViolations();
      expect(violations).toEqual([]);
    }
  });
});
