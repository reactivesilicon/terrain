# Plan 007: Harden accessors, namespaces, and views to null-prototype (fix latent name collisions)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat f283d71..HEAD -- src/accessors.ts src/module-composition/module-namespaces.ts src/module-composition/container-views.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (edits the perf-tuned accessor that carries a sync/async variance brand; behavior must stay identical except for the bug fix)
- **Depends on**: none (but land before plan 008, which relies on the null-prototype views)
- **Category**: bug
- **Planned at**: commit `f283d71`, 2026-06-21

## Why this matters

The composition layer turns names into object **property keys** — entry names
become keys on the accessor object (`r.Infra.logger`), module names become keys on
the namespace and container-view objects (`app.Infra`). All three are built as
**plain objects** (with `Object.prototype` in their chain), and the accessor
instance additionally stores two string-named own data properties, `source` and
`accessorCache`. As a result, several **valid-identifier names silently collide
today** (confirmed by experiment):

- An entry named `source` or `accessorCache` resolves to the internal resolver /
  cache object instead of the entry value (the own data property shadows the entry
  getter).
- An entry named `toString` (or the cache key `toString`) hits `Object.prototype`:
  the cache lookup `cache["toString"]` returns the built-in function (truthy), so
  the accessor is mis-cached; coercion of the namespace misbehaves.
- A future module/entry named `__proto__` assigned via bracket notation would
  mutate an object's prototype rather than set a property.

These pass `isIdentifierName`, so they are accepted and then misbehave. This plan
makes every object whose keys are user-chosen **null-prototype**, and moves the
accessor's internal state to **Symbol keys**, so no user name can ever collide with
an inherited or internal property — fixing the bug and laying the foundation plan
008 needs to safely drop the PascalCase restriction on module names.

## Current state

### `src/accessors.ts` — the accessor prototype (string-keyed internal state)

```ts
declare const REQUIRED_SOURCE: unique symbol;

interface AccessorInstance<Source extends SyncResolver> {
  readonly source: Source;
  readonly accessorCache: Record<string, (() => unknown) | undefined>;
}

export class AccessorPrototype<Source extends SyncResolver> {
  declare readonly [REQUIRED_SOURCE]?: (source: Source) => void;

  constructor(resolversByName: Record<string, (source: Source) => unknown>) {
    for (const [name, resolve] of Object.entries(resolversByName)) {
      Object.defineProperty(this, name, {
        enumerable: true,
        get(this: AccessorInstance<Source>) {
          const cached = this.accessorCache[name]; // cache is a plain {} → "toString" hits Object.prototype
          if (cached) return cached;
          const source = this.source;
          const accessor = () => resolve(source);
          this.accessorCache[name] = accessor;
          return accessor;
        },
      });
    }
    Object.freeze(this);
  }

  instantiate(source: Source): object {
    const instance = Object.create(this) as AccessorInstance<Source>;
    Object.defineProperties(instance, {
      source: { value: source }, // string own props → shadow entry getters named "source"/"accessorCache"
      accessorCache: { value: {} }, // plain {} → "toString" key collision
    });
    return Object.freeze(instance);
  }
}
```

The `REQUIRED_SOURCE` phantom brand makes a sync-only prototype reject instantiation
over a non-async resolver; it must be preserved. `buildSyncAccessorPrototype`,
`buildAccessorPrototype`, and `createAccessors` (same file) call `new
AccessorPrototype(...)` / `.instantiate(...)` and do **not** change.

### `src/module-composition/module-namespaces.ts` — plain namespace objects

```ts
// in createResolverNamespaceBuilder → buildNamespaces (line ~45):
const namespaces: Record<string, unknown> = {};
for (const used of usedModules) namespaces[used.name] = usedPrototype(used).instantiate(resolver);
namespaces[moduleName] = ownPrototype.instantiate(resolver);
return Object.freeze(namespaces);

// in buildContainerNamespaces (line ~65):
const namespaces: Record<string, unknown> = {};
for (const exposedModule of exposedModules) {
  if (exposedModule.name in namespaces) throw new DuplicateModuleNameError(exposedModule.name);
  namespaces[exposedModule.name] = exposedModule.namespacePrototypes.full.instantiate(container);
}
return namespaces;
```

### `src/module-composition/container-views.ts` — plain view objects (Object.prototype)

```ts
export function buildScopeView<...>(scopeContainer, exposedModules): ScopeView<Parts> {
  return Object.freeze({
    ...buildContainerNamespaces(scopeContainer, exposedModules),
    scope: buildScopeMethod<Parts>(scopeContainer, exposedModules),
    dispose: () => scopeContainer.dispose(),
  }) as ScopeView<Parts>;
}

export function buildContainerView<...>(container, exposedModules): ContainerView<Parts> {
  return Object.freeze({
    ...buildContainerNamespaces(container, exposedModules),
    scope: buildScopeMethod<Parts>(container, exposedModules),
    start: () => container.start(),
    dispose: () => container.dispose(),
  }) as ContainerView<Parts>;
}
```

Repo convention (`STATUS.md`): _"Names do the narration; comments do the proofs"_ —
the Symbol/null-proto choices each get a one-line comment proving why they're safe.

## Commands you will need

| Purpose           | Command                                                      | Expected    |
| ----------------- | ------------------------------------------------------------ | ----------- |
| Typecheck all     | `bun run typecheck:all`                                      | exit 0      |
| Accessor tests    | `bun run test -- accessors`                                  | pass        |
| Composition tests | `bun run test -- module-composition`                         | pass        |
| Full gate         | `bun run quality`                                            | exit 0      |
| Run examples      | `bun examples/public-api-usage.ts && bun examples/engine.ts` | both exit 0 |

## Scope

**In scope** (the only files you modify):

- `src/accessors.ts` — null-prototype carrier + Symbol-keyed `source`/`cache`.
- `src/module-composition/module-namespaces.ts` — null-proto namespace objects (both spots).
- `src/module-composition/container-views.ts` — null-proto view objects (both spots).
- `test/runs/accessors.test.ts` — add the collision regression test.
- `test/runs/module-composition.test.ts` — add the end-to-end regression test.

**Out of scope** (do NOT touch):

- Name validation / the PascalCase rule — that is plan 008. This plan changes **no
  public API and no accepted-name set**; entries named `source` etc. are already
  legal identifiers, this just makes them work.
- `src/container/`, tokens, the engine.
- The `REQUIRED_SOURCE` brand semantics — keep it exactly; only the runtime carrier
  of the getters changes.

## Git workflow

- Branch: `advisor/007-nullproto-hardening` off the current branch.
- Conventional Commits; e.g. `fix: null-prototype accessors/namespaces so entry names cannot shadow internals`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Rebuild the accessor on a null-prototype carrier with Symbol state

In `src/accessors.ts`, introduce two module-level Symbols and rework
`AccessorPrototype` so (a) the lazy getters live on a **null-prototype** object,
(b) per-instance `source`/`cache` are stored under Symbol keys, and (c) the cache is
itself null-prototype. Target shape:

```ts
const ACCESSOR_SOURCE = Symbol("terrain.accessor.source");
const ACCESSOR_CACHE = Symbol("terrain.accessor.cache");

interface AccessorInstance<Source extends SyncResolver> {
  readonly [ACCESSOR_SOURCE]: Source;
  readonly [ACCESSOR_CACHE]: Record<string, (() => unknown) | undefined>;
}

export class AccessorPrototype<Source extends SyncResolver> {
  declare readonly [REQUIRED_SOURCE]?: (source: Source) => void;

  // Null-prototype carrier of the getters: no Object.prototype names are
  // inherited, so an entry named toString/constructor/__proto__ is a plain
  // accessor and cannot shadow a built-in.
  readonly #getters: object;

  constructor(resolversByName: Record<string, (source: Source) => unknown>) {
    const getters = Object.create(null) as Record<string, unknown>;
    for (const [name, resolve] of Object.entries(resolversByName)) {
      Object.defineProperty(getters, name, {
        enumerable: true,
        get(this: AccessorInstance<Source>) {
          const cache = this[ACCESSOR_CACHE];
          const cached = cache[name];
          if (cached) return cached;
          const accessor = () => resolve(this[ACCESSOR_SOURCE]);
          cache[name] = accessor;
          return accessor;
        },
      });
    }
    this.#getters = Object.freeze(getters);
    Object.freeze(this);
  }

  /** O(1): a per-source instance inheriting the shared getters. Internal state
   *  is Symbol-keyed and the cache is null-prototype, so no string entry name
   *  can collide with it. */
  instantiate(source: Source): object {
    const instance = Object.create(this.#getters) as AccessorInstance<Source>;
    Object.defineProperty(instance, ACCESSOR_SOURCE, { value: source });
    Object.defineProperty(instance, ACCESSOR_CACHE, { value: Object.create(null) });
    return Object.freeze(instance);
  }
}
```

Leave `buildSyncAccessorPrototype`, `buildAccessorPrototype`, and `createAccessors`
unchanged.

**Verify**: `bun run typecheck` → exit 0; `bun run test -- accessors` → pass.

### Step 2: Null-prototype the namespace objects

In `src/module-composition/module-namespaces.ts`, change both
`const namespaces: Record<string, unknown> = {};` to
`const namespaces: Record<string, unknown> = Object.create(null);`. The `in` check
and bracket assignments work unchanged on a null-proto object (and `__proto__`
becomes an ordinary key). Keep the existing `Object.freeze(namespaces)` where present.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Null-prototype the view objects

In `src/module-composition/container-views.ts`, replace each object-literal-spread
view with a null-prototype object that carries the namespaces plus the methods:

```ts
export function buildScopeView<Parts extends readonly ContainerPart[]>(
  scopeContainer: Container,
  exposedModules: readonly ComposedModuleInternals[],
): ScopeView<Parts> {
  return Object.freeze(
    Object.assign(Object.create(null), buildContainerNamespaces(scopeContainer, exposedModules), {
      scope: buildScopeMethod<Parts>(scopeContainer, exposedModules),
      dispose: () => scopeContainer.dispose(),
    }),
  ) as ScopeView<Parts>;
}

export function buildContainerView<Parts extends readonly ContainerPart[]>(
  container: Container,
  exposedModules: readonly ComposedModuleInternals[],
): ContainerView<Parts> {
  return Object.freeze(
    Object.assign(Object.create(null), buildContainerNamespaces(container, exposedModules), {
      scope: buildScopeMethod<Parts>(container, exposedModules),
      start: () => container.start(),
      dispose: () => container.dispose(),
    }),
  ) as ContainerView<Parts>;
}
```

**Verify**: `bun run typecheck` → exit 0; `bun run test -- module-composition` → pass;
`bun examples/public-api-usage.ts` → exit 0.

### Step 4: Add regression tests for the fixed collisions

1. In `test/runs/accessors.test.ts`, add a test that exercises the engine
   `createAccessors` directly with reserved-looking entry names. Use whatever token
   and container helpers that file already imports. Cover names `source`,
   `accessorCache`, and `toString`; assert each accessor returns the entry value.

2. In `test/runs/module-composition.test.ts`, add an end-to-end test through the
   public API:

```ts
it("entries named like accessor internals (source/accessorCache/toString) resolve to their values", () => {
  const M = createModule("M", (m) =>
    m
      .single("source", () => "S")
      .single("accessorCache", () => "C")
      .single("toString", () => "T"),
  );
  const app = createContainer({ parts: [M] });
  expect(app.M.source()).toBe("S");
  expect(app.M.accessorCache()).toBe("C");
  expect(app.M.toString()).toBe("T");
});
```

(Note: this uses the config-object `createContainer({ parts: [...] })` form from plan 006. If plan 006 is not yet landed on your branch, use the variadic form
`createContainer(M)` instead and leave a `// TODO: config form once 006 lands` note.)

**Verify**: `bun run test` → all pass, including the two new tests.

### Step 5: Full gate

**Verify** (all must pass):

- `bun run quality` → exit 0.
- `bun examples/public-api-usage.ts` and `bun examples/engine.ts` → exit 0.
- Plan 004's `test/runs/types.test.ts` assertions still hold (covered by `quality`).

## Test plan

- New: engine-level accessor test (`accessors.test.ts`) and end-to-end test
  (`module-composition.test.ts`) proving `source`/`accessorCache`/`toString` entries
  resolve to their values — these FAIL before this change and PASS after.
- Existing accessor + composition + stress suites must stay green (no behavior
  change beyond the fix).
- Enforcement: `bun run quality`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/accessors.ts` stores `source`/cache under Symbol keys; the getters live on a `Object.create(null)` carrier; the cache is `Object.create(null)`.
- [ ] `grep -n "source: { value" src/accessors.ts` → no match (the old string own-prop is gone).
- [ ] Namespace and view objects are built with `Object.create(null)` (no plain `{}` / object-literal-spread views).
- [ ] The two new regression tests exist and pass.
- [ ] `bun run quality` exits 0; both examples exit 0.
- [ ] `git status` shows only the in-scope files changed.
- [ ] `plans/README.md` status row for 007 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- The `REQUIRED_SOURCE` variance check stops compiling — e.g. a sync-only prototype
  is now wrongly instantiable over a plain resolver, or vice versa. Preserve that
  brand; report rather than weakening it.
- An existing accessor/composition test fails for a reason other than the fix (e.g.
  something depended on the view having `Object.prototype` — `app.hasOwnProperty`,
  `app.toString()`, `app instanceof Object`). Report it; do not silently change the
  test's intent.
- A regression test still fails after the change (the collision is not actually
  fixed) — report the observed value.
- Coverage or the stress tests reveal a meaningful performance regression in
  resolution. Report it (a micro-benchmark of accessor instantiation may be worth a
  follow-up; note the missing `bench/` from plan 002).

## Maintenance notes

For whoever owns this next:

- This is the foundation for plan 008 (dropping PascalCase on module names): once
  the view is null-prototype, a module named `toString`/`constructor`/`__proto__`
  is just a namespace key and can't shadow a built-in, so the only reserved module
  names are the genuine view methods `scope`/`start`/`dispose`.
- The accessor is on a hot path. If a benchmark is added later (see plan 002's
  missing `bench/`), include accessor instantiation + first/cached resolution.
- Symbols `ACCESSOR_SOURCE`/`ACCESSOR_CACHE` are module-private; never export them or
  the collision guarantee weakens.
