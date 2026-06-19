import { describe, expect, it } from "vitest";

import { delay, ignore } from "../helpers";
import { Container, createAsyncToken, createModule, createSyncToken } from "../internal-api";
import { DependentInstanceError, MissingDependencyError, type SyncResolver } from "../internal-api";

describe("unload safety: dependents", () => {
  it("unload is refused while a live singleton depends on the module", async () => {
    const A = createSyncToken<{ v: number }>("depA");
    const B = createSyncToken<{ a: { v: number } }>("depB");
    const modA = createModule((m) => m.single(A, () => ({ v: 1 })));
    const modB = createModule((m) => m.single(B, (r) => ({ a: r.get(A) })));
    const c = new Container();
    c.load(modA);
    c.load(modB);
    c.get(B); // B captures A's instance
    await expect(c.unload(modA)).rejects.toThrowError(DependentInstanceError);
    // Transactional: nothing was evicted or disposed.
    expect(c.get(A).v).toBe(1);
    expect(c.get(B).a.v).toBe(1);
    // Unloading the dependent first unblocks the dependency.
    await c.unload(modB);
    await c.unload(modA);
  });

  it("capture through a factory attributes to the caching dependent", async () => {
    const A = createSyncToken<object>("tfA");
    const F = createSyncToken<{ a: object }>("tfF");
    const C = createSyncToken<{ f: { a: object } }>("tfC");
    const modA = createModule((m) => m.single(A, () => ({})));
    const rest = createModule((m) => {
      m.factory(F, (r) => ({ a: r.get(A) }));
      m.single(C, (r) => ({ f: r.get(F) }));
    });
    const c = new Container();
    c.load(modA);
    c.load(rest);
    c.get(C); // C -> factory F -> A; the live holder is C
    const refusal = await c.unload(modA).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(DependentInstanceError);
    expect((refusal as Error).message).toContain("tfC");
    await c.unload(rest);
    await c.unload(modA);
  });

  it("transient use during construction still blocks (conservative by design)", async () => {
    const Cfg = createSyncToken<{ url: string }>("transCfg");
    const Svc = createSyncToken<{ url: string }>("transSvc");
    const cfgMod = createModule((m) => m.single(Cfg, () => ({ url: "db://x" })));
    const svcMod = createModule((m) =>
      // Svc copies a value out of Cfg and does NOT keep the reference; the
      // container cannot see that, so unload(cfgMod) is still refused.
      m.single(Svc, (r) => ({ url: r.get(Cfg).url })),
    );
    const c = new Container();
    c.load(cfgMod);
    c.load(svcMod);
    c.get(Svc);
    await expect(c.unload(cfgMod)).rejects.toThrowError(DependentInstanceError);
  });

  it("disposing the scope that holds the dependent unblocks unload", async () => {
    const A = createSyncToken<object>("scA");
    const B = createSyncToken<{ a: object }>("scB");
    const modA = createModule((m) => m.single(A, () => ({})));
    const modB = createModule((m) => m.scoped(B, (r) => ({ a: r.get(A) })));
    const root = new Container();
    root.load(modA);
    root.load(modB);
    const scope = root.createScope();
    scope.get(B);
    await expect(root.unload(modA)).rejects.toThrowError(DependentInstanceError);
    await scope.dispose();
    await root.unload(modA); // no live B instance remains anywhere in the tree
  });

  it("an in-flight async dependent blocks unload", async () => {
    const A = createSyncToken<object>("ifA");
    const B = createAsyncToken<{ a: object }>("ifB");
    const modA = createModule((m) => m.single(A, () => ({})));
    const modB = createModule((m) =>
      m.singleAsync(B, async (r) => {
        const a = r.get(A); // edge recorded before the suspension below
        await delay(30);
        return { a };
      }),
    );
    const c = new Container();
    c.load(modA);
    c.load(modB);
    const pending = ignore(c.getAsync(B));
    await delay(5);
    await expect(c.unload(modA)).rejects.toThrowError(DependentInstanceError);
    await pending;
    await c.unload(modB);
    await c.unload(modA);
  });

  it("async dependent via getAsync is tracked like sync", async () => {
    const A = createAsyncToken<object>("agA");
    const B = createAsyncToken<{ a: object }>("agB");
    const modA = createModule((m) => m.singleAsync(A, async () => ({})));
    const modB = createModule((m) => m.singleAsync(B, async (r) => ({ a: await r.getAsync(A) })));
    const c = new Container();
    c.load(modA);
    c.load(modB);
    await c.getAsync(B);
    await expect(c.unload(modA)).rejects.toThrowError(DependentInstanceError);
    await c.unload(modB);
    await c.unload(modA);
  });

  it("dependents inside the same module do not block its own unload", async () => {
    const A = createSyncToken<object>("selfA");
    const B = createSyncToken<{ a: object }>("selfB");
    const mod = createModule((m) => {
      m.single(A, () => ({}));
      m.single(B, (r) => ({ a: r.get(A) }));
    });
    const c = new Container();
    c.load(mod);
    c.get(B);
    await c.unload(mod); // A's dependent B is evicted in the same operation
  });

  it("override purges the replaced definition's stale edges", async () => {
    const A = createSyncToken<object>("ovEdgeA");
    const B = createSyncToken<object>("ovEdgeB");
    const modA = createModule((m) => m.single(A, () => ({})));
    const oldB = createModule((m) => m.scoped(B, (r) => ({ a: r.get(A) })));
    const newB = createModule((m) => m.scoped(B, () => ({}))); // no dependency on A
    const root = new Container();
    root.load(modA);
    root.load(oldB);
    const s1 = root.createScope();
    s1.get(B); // old B captures A
    await s1.dispose(); // no live B remains -> override becomes legal
    root.load(newB, { override: true });
    const s2 = root.createScope();
    s2.get(B); // new B, independent of A
    await root.unload(modA); // must not be blocked by the dead incarnation's edge
    await root.dispose();
  });

  it("a stashed resolver used after construction still records the capture", async () => {
    const A = createSyncToken<object>("escA");
    const B = createSyncToken<{ poke(): object }>("escB");
    const modA = createModule((m) => m.single(A, () => ({})));
    const modB = createModule((m) => m.single(B, (r: SyncResolver) => ({ poke: () => r.get(A) })));
    const c = new Container();
    c.load(modA);
    c.load(modB);
    c.get(B).poke(); // late resolution -> edge recorded at the call
    await expect(c.unload(modA)).rejects.toThrowError(DependentInstanceError);
  });

  it("a stashed resolver after unload fails loudly instead of resurrecting the token", async () => {
    const A = createSyncToken<object>("escPostA");
    const B = createSyncToken<{ poke(): object }>("escPostB");
    const modA = createModule((m) => m.single(A, () => ({})));
    const modB = createModule((m) => m.single(B, (r: SyncResolver) => ({ poke: () => r.get(A) })));
    const c = new Container();
    c.load(modA);
    c.load(modB);
    const b = c.get(B); // A never resolved -> no edge, unload is allowed
    await c.unload(modA);
    expect(() => b.poke()).toThrowError(MissingDependencyError);
  });

  it("edges are tree-local: another tree's captures do not block unload", async () => {
    const A = createSyncToken<object>("xtA");
    const B = createSyncToken<{ a: object }>("xtB");
    const modA = createModule((m) => m.single(A, () => ({})));
    const modB = createModule((m) => m.single(B, (r) => ({ a: r.get(A) })));
    const t1 = new Container();
    t1.load(modA);
    t1.load(modB);
    t1.get(B); // capture exists only in t1
    const t2 = new Container();
    t2.load(modA);
    t2.load(modB);
    await t2.unload(modA); // t2 has no live dependent
    await expect(t1.unload(modA)).rejects.toThrowError(DependentInstanceError);
  });

  it("edges are purged on unload: a reloaded independent dependent does not block", async () => {
    const A = createSyncToken<object>("rlA");
    const B = createSyncToken<object>("rlB");
    const modA = createModule((m) => m.single(A, () => ({})));
    const oldB = createModule((m) => m.single(B, (r) => ({ a: r.get(A) })));
    const newB = createModule((m) => m.single(B, () => ({}))); // no dependency on A
    const c = new Container();
    c.load(modA);
    c.load(oldB);
    c.get(B);
    await c.unload(oldB); // purges B's edges
    c.load(newB);
    c.get(B);
    await c.unload(modA); // must not be blocked by the stale edge
    expect(c.has(B), "independent B stays loaded").toBeTruthy();
  });
});
