import { describe, expect, it } from "vitest";

import { delay, ignore, random } from "../helpers";
import { Container, createAsyncToken, createModule, createSyncToken, DIError } from "../internal-api";
import type { AsyncToken, Module, Token } from "../internal-api";

/**
 * Property/stress suite: random operation sequences against a container tree,
 * with four global invariants checked after every step and at teardown:
 *   1. a successful resolution never returns an already-disposed instance,
 *   2. no disposer ever runs twice for one instance,
 *   3. at final teardown every cached instance with a disposer ran it exactly once,
 *   4. every thrown error is a framework error (DIError / AggregateError).
 * Failures print the operation log; the printed TEST_SEED replays the run.
 */

interface Instance {
  id: number;
  disposeCount: number;
}

interface GeneratedModule {
  module: Module;
  syncTokens: Token<Instance>[];
  asyncTokens: AsyncToken<Instance>[];
  loadedOn: Container | null;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function chance(probability: number): boolean {
  return random() < probability;
}

describe("stress: random operation sequences", () => {
  it("uphold the container's global invariants", { timeout: 60_000 }, async () => {
    const SEQUENCES = 20;
    const OPS_PER_SEQUENCE = 50;

    for (let sequence = 0; sequence < SEQUENCES; sequence += 1) {
      const opLog: string[] = [];
      const violations: string[] = [];
      const instances: { instance: Instance; cached: boolean; hasDisposer: boolean }[] = [];
      let nextInstanceId = 0;
      let nextTokenId = 0;

      const recordViolation = (message: string): void => {
        violations.push(message);
      };

      const assertNoViolations = (): void => {
        if (violations.length === 0) return;
        throw new Error(`sequence ${sequence}: ${violations.join("; ")}\nlast ops:\n${opLog.slice(-25).join("\n")}`);
      };

      const isFrameworkError = (e: unknown): boolean => e instanceof DIError || e instanceof AggregateError;

      const checkResolved = (value: Instance, op: string): void => {
        if (value.disposeCount > 0) {
          recordViolation(`${op} returned instance #${value.id} whose disposer already ran (use-after-dispose)`);
        }
      };

      const checkError = (e: unknown, op: string): void => {
        if (!isFrameworkError(e)) {
          recordViolation(`${op} threw a non-framework error: ${String(e)}`);
        }
      };

      const makeDisposer = () => {
        const throws = chance(0.05);
        return (x: Instance) => {
          x.disposeCount += 1;
          if (x.disposeCount > 1) recordViolation(`instance #${x.id} disposed ${x.disposeCount} times`);
          if (throws) throw new Error(`disposer-fail-${x.id}`);
        };
      };

      const makeModule = (): GeneratedModule => {
        const syncTokens: Token<Instance>[] = [];
        const asyncTokens: AsyncToken<Instance>[] = [];
        const definitionCount = 3 + Math.floor(random() * 4);

        const module = createModule((m) => {
          for (let d = 0; d < definitionCount; d += 1) {
            const isAsync = chance(0.4);
            const lifetime = pick(["single", "factory", "scoped"] as const);
            const cached = lifetime !== "factory";
            const hasDisposer = chance(0.7);
            const fails = chance(0.05);
            // Sync providers may only depend on earlier sync tokens; async
            // providers may also await earlier async ones.
            const syncDeps = syncTokens.filter(() => chance(0.3)).slice(0, 2);
            const asyncDeps = isAsync ? asyncTokens.filter(() => chance(0.3)).slice(0, 2) : [];

            const construct = (deps: Instance[]): Instance => {
              if (fails) throw new Error("provider-fail");
              const instance: Instance = { id: nextInstanceId, disposeCount: 0 };
              nextInstanceId += 1;
              instances.push({ instance, cached, hasDisposer });
              // Real capture: the instance holds its dependencies.
              Object.assign(instance, { deps });
              return instance;
            };
            const options = hasDisposer ? { dispose: makeDisposer() } : {};

            if (isAsync) {
              const token = createAsyncToken<Instance>(`s${sequence}t${nextTokenId}`);
              nextTokenId += 1;
              const provider = async (r: {
                get: <T>(t: Token<T>) => T;
                getAsync: <T>(t: AsyncToken<T>) => Promise<T>;
              }) => {
                const deps = syncDeps.map((t) => r.get(t));
                for (const t of asyncDeps) deps.push(await r.getAsync(t));
                await delay(random() * 2);
                return construct(deps);
              };
              if (lifetime === "single") {
                m.singleAsync(token, provider, chance(0.2) ? { ...options, eager: true } : options);
              } else if (lifetime === "scoped") m.scopedAsync(token, provider, options);
              else m.factoryAsync(token, provider, options);
              asyncTokens.push(token);
            } else {
              const token = createSyncToken<Instance>(`s${sequence}t${nextTokenId}`);
              nextTokenId += 1;
              const provider = (r: { get: <T>(t: Token<T>) => T }) => construct(syncDeps.map((t) => r.get(t)));
              if (lifetime === "single") {
                m.single(token, provider, chance(0.2) ? { ...options, eager: true } : options);
              } else if (lifetime === "scoped") m.scoped(token, provider, options);
              else m.factory(token, provider, options);
              syncTokens.push(token);
            }
          }
        });

        return { module, syncTokens, asyncTokens, loadedOn: null };
      };

      // ── sequence state ──
      const root = new Container();
      const containers: Container[] = [root];
      const modules: GeneratedModule[] = [];
      const pendingResolutions: Promise<void>[] = [];
      // Counts dispose/unload attempts. A fired-and-forgotten resolution may
      // legitimately observe a disposed instance if a teardown ran between its
      // settlement and its (microtask-late) callback — the use-after-dispose
      // check only applies when no teardown interleaved.
      let teardownCount = 0;

      const settlePending = async (): Promise<void> => {
        await Promise.allSettled(pendingResolutions.splice(0));
      };

      const initial = makeModule();
      root.load(initial.module);
      initial.loadedOn = root;
      modules.push(initial);

      for (let op = 0; op < OPS_PER_SEQUENCE; op += 1) {
        const roll = random();
        const allSync = modules.flatMap((g) => g.syncTokens);
        const allAsync = modules.flatMap((g) => g.asyncTokens);

        try {
          if (roll < 0.28 && allSync.length > 0) {
            const container = pick(containers);
            const token = pick(allSync);
            opLog.push(`#${op} get(${token.description})`);
            checkResolved(container.get(token), `get(${token.description})`);
          } else if (roll < 0.48 && allAsync.length > 0) {
            const container = pick(containers);
            const token = pick(allAsync);
            if (chance(0.5)) {
              opLog.push(`#${op} await getAsync(${token.description})`);
              checkResolved(await container.getAsync(token), `getAsync(${token.description})`);
            } else {
              opLog.push(`#${op} fire getAsync(${token.description})`);
              const teardownAtFire = teardownCount;
              pendingResolutions.push(
                ignore(
                  container.getAsync(token).then(
                    (v) => {
                      if (teardownCount === teardownAtFire) {
                        checkResolved(v, `pending getAsync(${token.description})`);
                      }
                    },
                    (e) => checkError(e, `pending getAsync(${token.description})`),
                  ),
                ),
              );
            }
          } else if (roll < 0.6) {
            const generated = makeModule();
            const container = pick(containers);
            opLog.push(`#${op} load on container ${containers.indexOf(container)}`);
            container.load(generated.module);
            generated.loadedOn = container;
            modules.push(generated);
          } else if (roll < 0.72) {
            const parent = pick(containers);
            opLog.push(`#${op} createScope of ${containers.indexOf(parent)}`);
            containers.push(parent.createScope());
          } else if (roll < 0.82 && modules.length > 0) {
            const generated = pick(modules);
            // Mostly the right container; sometimes a wrong/stale one to
            // exercise the ownership refusal.
            const target = chance(0.8) && generated.loadedOn ? generated.loadedOn : pick(containers);
            opLog.push(`#${op} unload from container ${containers.indexOf(target)}`);
            teardownCount += 1;
            await target.unload(generated.module);
            generated.loadedOn = null;
          } else if (roll < 0.9) {
            // Leaf-biased disposal; root only occasionally.
            const candidates = containers.length > 1 && chance(0.85) ? containers.slice(1) : containers;
            const container = pick(candidates);
            opLog.push(`#${op} dispose container ${containers.indexOf(container)}`);
            teardownCount += 1;
            await container.dispose();
          } else if (roll < 0.97) {
            const container = pick(containers);
            opLog.push(`#${op} start container ${containers.indexOf(container)}`);
            await container.start();
          } else {
            opLog.push(`#${op} settle pending`);
            await settlePending();
          }
        } catch (e) {
          checkError(e, opLog[opLog.length - 1] ?? "unknown op");
        }
        assertNoViolations();
      }

      // ── final teardown and leak audit ──
      await settlePending();
      try {
        await root.dispose();
      } catch (e) {
        checkError(e, "final dispose");
      }
      await delay(5); // let fire-and-forget orphan disposals land

      for (const { instance, cached, hasDisposer } of instances) {
        if (!hasDisposer) continue;
        if (cached && instance.disposeCount !== 1) {
          recordViolation(`cached instance #${instance.id} disposed ${instance.disposeCount} times (expected 1)`);
        }
        if (!cached && instance.disposeCount > 1) {
          recordViolation(`factory instance #${instance.id} disposed ${instance.disposeCount} times`);
        }
      }
      assertNoViolations();
      expect(violations).toEqual([]);
    }
  });
});
