# Plan 005: Contain the composition-builder casts into named, documented seams

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Depends on plan 004 being DONE** (the positive `expectTypeOf` assertions in
> `test/runs/types.test.ts`). Those tests are this plan's safety net — they catch
> any type regression this refactor introduces. If `test/runs/types.test.ts` does
> not exist, STOP: execute plan 004 first.
>
> **Drift check (run first)**:
> `git diff --stat 8df145a..HEAD -- src/module-composition/composition.ts src/module-composition/module-entry-definitions.ts src/module-composition/module-override/build-module-overrides.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (edits the type-tuned builder; behavior must stay identical)
- **Depends on**: plans/004-positive-type-assertions.md
- **Category**: tech-debt
- **Planned at**: commit `8df145a`, 2026-06-20

## Why this matters

The composed-module builder erases provider types through six casts. Four of them
(`provider as any`) are the _same_ operation — turning a richly-typed provider into
the type-erased shape the engine stores and invokes — scattered across two files
with no shared name or explanation. The other two (`as unknown as
ComposedModuleBuilder`, `overrideBuilder as any`) are the genuinely irreducible
seam of a phantom-accumulating fluent builder: a single runtime object cannot carry
the type of an interface whose every method "returns a type with one more entry."
**Be clear-eyed about scope: this is an auditability change, not a bug fix.** It
does not remove the casts' necessity; it collapses four ad-hoc `as any` into one
named, documented helper and replaces two vague `// TODO` comments on the
irreducible casts with an explanation of why they exist and what guards them. After
this, a reviewer sees three intentional, documented type seams instead of six
unexplained overrules. The behavior is identical and is fenced by plan 004's type
assertions plus the existing 173-test suite.

## Current state

### Cast site 1 & 2 — `composition.ts` (the entry builder)

`src/module-composition/composition.ts`, `makeBuilder` (lines ~54–97):

```ts
const addSync =
  (lifetime: Lifetime) =>
  (
    entryName: ModuleEntryName,
    provider: SyncModuleEntryProvider<ModuleName, ModuleEntries, typeof entryName>,
    options?: SingletonDefinitionOptions<unknown>,
  ) => {
    moduleEntryDefinitions.register({
      entryName: entryName,
      lifetime: lifetime,
      mode: TokenModes.Sync,
      provider: provider as any, // <-- cast 1
      options: options,
    });
    return builder;
  };

const addAsync = (lifetime: Lifetime) => (/* entryName, provider, options */) => {
  moduleEntryDefinitions.register({
    /* ... */
    mode: TokenModes.Async,
    provider: provider as any, // <-- cast 2
    options: options,
  });
  return builder;
};

// TODO: better typing
const builder = {
  single: addSync(Lifetimes.Singleton),
  /* ...singleAsync, factory, factoryAsync, scoped, scopedAsync... */
} as unknown as ComposedModuleBuilder<string, UsedModules, ModuleEntries>; // <-- IRREDUCIBLE seam A
return builder;
```

### Cast site 3, 4 & 5 — `build-module-overrides.ts`

`src/module-composition/module-override/build-module-overrides.ts` (lines ~64–99):

```ts
const collectSyncReplacement = <EntryName extends ModuleEntryName>(
  entryName: EntryName,
  provider: SyncModuleEntryProvider<ModuleName, ModuleEntries, EntryName>,
  options?: SingletonDefinitionOptions<unknown>,
): OverrideBuilder<ModuleName, ModuleEntries> => {
  const original = assertEntryCanBeReplaced(entryName, TokenModes.Sync, options);
  replacementsByEntryName.set(entryName, { ...original, provider: provider as any, options }); // <-- cast 3
  return overrideBuilder;
};

const collectAsyncReplacement = <EntryName extends ModuleEntryName>() /* entryName, provider, options */
: OverrideBuilder<ModuleName, ModuleEntries> => {
  const original = assertEntryCanBeReplaced(entryName, TokenModes.Async, options);
  replacementsByEntryName.set(entryName, { ...original, provider: provider as any, options }); // <-- cast 4
  return overrideBuilder;
};

// TODO: refine this, have stricter types here on the overrideBuilder
defineOverride(overrideBuilder as any); // <-- IRREDUCIBLE seam B
```

### The erased target type

`src/module-composition/module-entry-definitions.ts` defines the stored shape (the
provider field the four `provider as any` casts target):

```ts
type ResolverNamespacesValue = Record<ComposedModuleName, unknown>; // = Record<string, unknown>

type SyncProvision = {
  mode: typeof TokenModes.Sync;
  provider: (resolverNamespaces: ResolverNamespacesValue) => unknown;
};
type AsyncProvision = {
  mode: typeof TokenModes.Async;
  provider: (resolverNamespaces: ResolverNamespacesValue) => Promise<unknown>;
};
```

So casts 1 & 3 erase a sync provider to `(rn: ResolverNamespacesValue) => unknown`;
casts 2 & 4 erase an async provider to `(rn: ResolverNamespacesValue) => Promise<unknown>`.

Convention (`STATUS.md`): _"Names do the narration; comments do the proofs."_ The
helper's name narrates the erasure; its doc comment proves why it is safe (the
type tests).

## Commands you will need

| Purpose                 | Command                                                   | Expected on success          |
| ----------------------- | --------------------------------------------------------- | ---------------------------- |
| Typecheck src           | `bun run typecheck`                                       | exit 0, no errors            |
| Typecheck tests + types | `bun run typecheck:test`                                  | exit 0 (plan 004 net intact) |
| Run suite               | `bun run test`                                            | 173 tests pass               |
| Full gate               | `bun run quality`                                         | exit 0                       |
| Count remaining casts   | `grep -rn 'as any\|as unknown as' src/module-composition` | 2 matches after this plan    |

## Scope

**In scope** (the only files you modify):

- `src/module-composition/module-entry-definitions.ts` (add the erase helper(s))
- `src/module-composition/composition.ts` (use the helper; document seam A)
- `src/module-composition/module-override/build-module-overrides.ts` (use the helper; document seam B)

**Out of scope** (do NOT touch):

- The two irreducible casts themselves — `composition.ts` `as unknown as
ComposedModuleBuilder` and `build-module-overrides.ts` `overrideBuilder as any`.
  Do NOT attempt to remove them; only replace their `// TODO` comments with the
  documented-seam comment in Step 3. Trying to "fix" them means restructuring the
  generic fluent-builder types — high risk, separate effort, not this plan.
- `test/` — do not modify plan 004's assertions; they are the verification.
- Any engine file under `src/container/`, `src/module.ts`, etc.
- Provider invocation behavior — the runtime must be byte-for-byte equivalent;
  this is a type-only refactor.

## Git workflow

- Branch: `advisor/005-contain-builder-casts`.
- Conventional Commits; e.g. `refactor: collapse builder provider-erasure into a named seam`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the named erasure helper(s)

In `src/module-composition/module-entry-definitions.ts`, add exported helper(s)
that perform the provider type-erasure with a single documented assertion.
Candidate implementation (adjust the internal types only as Step 4 requires):

```ts
/** The composed-module builder's one intentional type-erasure seam. Entry and
 *  override providers are authored against rich namespace-resolver types
 *  (SyncProviderResolver / AsyncProviderResolver) but are stored and invoked
 *  type-erased: the engine calls them with the runtime namespaces object. The
 *  rich public surface they erase from is pinned by the positive expectTypeOf
 *  assertions in test/runs/types.test.ts — those tests, not the compiler, are
 *  what catch a regression at this boundary. */
export function eraseSyncEntryProvider(
  provider: (resolver: never) => unknown,
): (resolverNamespaces: ResolverNamespacesValue) => unknown {
  return provider as (resolverNamespaces: ResolverNamespacesValue) => unknown;
}

export function eraseAsyncEntryProvider(
  provider: (resolver: never) => Promise<unknown>,
): (resolverNamespaces: ResolverNamespacesValue) => Promise<unknown> {
  return provider as (resolverNamespaces: ResolverNamespacesValue) => Promise<unknown>;
}
```

Notes:

- The parameter type uses `never`, not `any` — every provider function is
  assignable to `(resolver: never) => unknown`, so call sites stay cast-free
  without introducing an `any` parameter.
- If the single `as` in a body does not compile, widen it to `as unknown as` —
  but keep exactly one assertion per helper and keep the doc comment.
- `ResolverNamespacesValue` is already declared in this file; reuse it.

**Verify**: `bun run typecheck` → exit 0 (the new helpers compile).

### Step 2: Use the helper at the four `provider as any` sites

Replace each `provider: provider as any` with a call to the matching helper:

- `composition.ts` cast 1 (sync): `provider: eraseSyncEntryProvider(provider),`
- `composition.ts` cast 2 (async): `provider: eraseAsyncEntryProvider(provider),`
- `build-module-overrides.ts` cast 3 (sync):
  `replacementsByEntryName.set(entryName, { ...original, provider: eraseSyncEntryProvider(provider), options });`
- `build-module-overrides.ts` cast 4 (async): same with `eraseAsyncEntryProvider`.

Add the import for the helper(s) in both files (from
`./module-entry-definitions` / `../module-entry-definitions`).

There must be **no `as any` and no `as` at these four call sites** after the
change — the assertion now lives only inside the helper.

**Verify**:

- `bun run typecheck` → exit 0.
- `grep -rn 'provider as any' src/module-composition` → no matches.

### Step 3: Document the two irreducible seams

Replace the vague TODO comments with an explanation (do NOT change the casts):

- In `composition.ts`, replace `// TODO: better typing` (just above the `const
builder = { ... } as unknown as ComposedModuleBuilder<...>`) with:
  ```ts
  // Phantom-builder seam: a single runtime object cannot carry the type of a
  // fluent interface whose every method returns a type with one more entry
  // accumulated. This assertion is irreducible; the resulting public types are
  // pinned by test/runs/types.test.ts.
  ```
- In `build-module-overrides.ts`, replace `// TODO: refine this, have stricter
types here on the overrideBuilder` (just above `defineOverride(overrideBuilder
as any);`) with:
  ```ts
  // Phantom-builder seam: overrideBuilder's runtime methods use looser generics
  // than the OverrideBuilder interface's entry-name constraints, so the object
  // is not structurally assignable to it. Irreducible; pinned by
  // test/runs/types.test.ts.
  ```

**Verify**: `bun run typecheck` → exit 0; `grep -rn 'TODO' src/module-composition`
no longer lists these two lines.

### Step 4: Confirm behavior and types are unchanged

The whole point is zero behavioral and zero public-type change.

**Verify** (all must pass):

- `bun run typecheck` → exit 0.
- `bun run typecheck:test` → exit 0. **This is the load-bearing check**: plan
  004's positive assertions in `test/runs/types.test.ts` must still hold, proving
  the accessor/resolver types did not drift (e.g. no new `any`-leak) from the
  refactor.
- `bun run test` → 173 tests pass (no behavioral change).
- `bun run quality` → exit 0.
- `grep -rn 'as any\|as unknown as' src/module-composition` → exactly 2 matches:
  the `as unknown as ComposedModuleBuilder` in `composition.ts` and the
  `overrideBuilder as any` in `build-module-overrides.ts`. The four
  `provider as any` are gone.

## Test plan

No new tests. Verification is entirely existing gates + plan 004's assertions:

- `bun run typecheck:test` proves the public types are unchanged (004's net).
- `bun run test` proves runtime behavior is unchanged (173 tests).
- The `grep` count proves the four provider casts were collapsed and only the two
  documented seams remain.

If you find yourself wanting a new test, you don't need one — this plan changes no
behavior; STOP and reconsider whether you've drifted out of scope.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `eraseSyncEntryProvider` / `eraseAsyncEntryProvider` (or one documented generic) exist in `module-entry-definitions.ts` with the doc comment.
- [ ] `grep -rn 'provider as any' src/module-composition` returns no matches.
- [ ] `grep -rn 'as any\|as unknown as' src/module-composition` returns exactly 2 matches (the two documented irreducible seams).
- [ ] The two `// TODO` comments at those seams are replaced with the documented-seam comments.
- [ ] `bun run typecheck`, `bun run typecheck:test`, `bun run test`, and `bun run quality` all exit 0.
- [ ] `git status` shows only the three in-scope `src/module-composition/...` files modified — nothing in `test/` or elsewhere.
- [ ] `plans/README.md` status row for 005 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 004's `test/runs/types.test.ts` does not exist — execute 004 first.
- After Step 2, `bun run typecheck:test` fails on a `test/runs/types.test.ts`
  assertion. That means the refactor changed a public type (a real regression) —
  revert and report; do not weaken the assertion.
- Removing a `provider as any` requires adding a cast somewhere else to make it
  compile (you've moved the cast, not contained it) — report the signature you got
  stuck on.
- You are tempted to touch either irreducible seam to "also fix" it — that is out
  of scope (high risk); stop and report it as a possible future spike.
- The cited code does not match the "Current state" excerpts (drift).

## Maintenance notes

For whoever owns this next:

- This is auditability, not a behavior change. A reviewer should confirm
  `bun run test` is still 173 green and that plan 004's type assertions still pass
  — together those prove nothing observable changed.
- The two remaining seams are genuinely irreducible without restructuring the
  phantom-accumulating fluent-builder generics. If someone wants zero casts, that
  is the separate, high-risk "zero-cast typing" effort STATUS.md defers — not this.
- If the erase helper's input is ever loosened from `(resolver: never)` to `any`,
  that reintroduces the smell this plan removed; keep `never`.
