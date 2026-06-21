# Plan 006: Implement `createContainer({ options, parts })` (config-object form)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat aed40ba..HEAD -- src/module-composition/ src/index.ts src/types.ts README.md examples/ test/runs/module-composition.test.ts test/runs/types.test.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (breaking public-API change with a wide but mechanical migration; well-fenced by the type net + gate)
- **Depends on**: 003 (design — decision inlined below), and 001 + 004 should be DONE (their gates catch migration mistakes; they are DONE on this branch)
- **Category**: direction
- **Planned at**: commit `aed40ba`, 2026-06-21

## Why this matters

The engine `Container` accepts `ContainerOptions`, but the composition API has no
way to pass them: `createContainer` builds the root with `new Container()`, so the
`onDisposeError` hook (which observes disposal failures of *orphaned* in-flight
instances — resolutions that completed after `dispose()`/`unload()` already evicted
their token) is unreachable through the public API. Composition users silently lose
that signal. The design spike (plan 003) chose the **config-object form** as the
single public shape:

```ts
const app = createContainer({ options: { onDisposeError }, parts: [Infra, Data] });
```

**Decision (from the maintainer, recorded here so this plan is self-contained):**
- Adopt the config object as the **sole** form. **Remove** the variadic
  `createContainer(...parts)`. This is a breaking change; the maintainer has
  accepted it because migration is a one-line, mechanical edit per call site, and
  it ships in **1.2.0**.
- Config keys are **`options`** and **`parts`** (flag this naming for confirmation
  in the PR description; it is the spike's recommendation).
- Expose only the existing narrow `onDisposeError`; do **not** broaden the hook's
  semantics in this plan.

The config object is runtime-unambiguous (no module/override sniffing needed — the
first and only argument is always the config), preserves exact namespace inference
by putting `const Parts` on `config.parts`, and leaves room for future root-level
options. Scopes inherit options automatically (the engine's `createScope()` already
passes `this.options` to children), so no scope-layer work is needed.

## Current state

### `createContainer` today (`src/module-composition/composition.ts:187`)

```ts
export function createContainer<const Parts extends readonly ContainerPart[]>(...parts: Parts): ContainerView<Parts> {
  const exposed: ComposedModuleInternals[] = [];
  const overrides: OverrideInternals[] = [];
  for (const part of parts) {
    const overrideInternals = findOverrideInternals(part as ModuleOverride<string>);
    if (overrideInternals) overrides.push(overrideInternals);
    else exposed.push(requireModuleInternals(part as ComposedModule<string, ModuleEntryMap>));
  }

  const wiring = wiringOf(exposed);

  for (const override of overrides) {
    if (!wiring.has(override.targetModule)) {
      throw new InvalidModuleUseError(
        `Override targets module '${override.targetModule.name}' which is not part of this container's wiring.`,
      );
    }
  }

  const container = new Container();                 // <-- options not threaded
  for (const wiringModule of wiring) {
    container.load(wiringModule.kernelModule);
  }
  for (const override of overrides) {
    container.load(buildOverrideKernelModule(override), { override: true });
  }

  return buildContainerView<Parts>(container, exposed);
}
```

### `ContainerOptions` (`src/types.ts:81`) — defined, but NOT publicly exported

```ts
export interface ContainerOptions {
  /** Observe disposal errors for ORPHANED in-flight instances only ... */
  onDisposeError?: (error: unknown) => void;
}
```

`Container`'s constructor is `constructor(options: ContainerOptions = {})`
(`src/container/container.ts:71`), and `createScope()` does `new Container(this.options)`
(`src/container/container.ts:237-243`) — scopes inherit options for free.

### Export surface

- `src/index.ts` (root public entry): `export * from "./module-composition";` plus
  `export type { DefinitionOptions, Disposer, SingletonDefinitionOptions } from "./types";`
  — **no `ContainerOptions`**.
- `src/module-composition/index.ts` re-exports the public composition types from
  `./types` (`ContainerView`, `ContainerPart`, etc.). Because `src/index.ts` does
  `export * from "./module-composition"`, anything exported there becomes public.

### Public types (`src/module-composition/types.ts`)

`ContainerPart = ComposedModule<...> | ModuleOverride<...>` (line ~187),
`ContainerView<Parts>` (lines ~199-205). `ContainerView` does **not** change — only
the function's input shape changes. This file already imports from `../types`
(e.g. `SingletonDefinitionOptions`), so importing `ContainerOptions` there is consistent.

### Migration surface (all `createContainer(` call sites — verified counts)

| File | Calls | Notes |
|------|-------|-------|
| `README.md` | 7 calls + 1 signature doc at line 496 | Code snippets + the `### createContainer` API section |
| `examples/public-api-usage.ts` | 2 | `createContainer(infraModule, dataModule, actionsModule)` and the override one |
| `test/runs/module-composition.test.ts` | 29 | The bulk — mechanical |
| `test/runs/types.test.ts` | 2 | The plan 004 type-net file; migrate + extend |

`examples/engine.ts` uses raw `new Container()` (deep-import kernel example) and is
**not** affected.

## Commands you will need

| Purpose             | Command                                                                                  | Expected                          |
|---------------------|------------------------------------------------------------------------------------------|-----------------------------------|
| Typecheck all       | `bun run typecheck:all`                                                                  | exit 0 (src + test + examples)    |
| Run suite           | `bun run test`                                                                           | all pass (≥178; +1 new test)      |
| Full gate           | `bun run quality`                                                                       | exit 0                            |
| Run public example  | `bun examples/public-api-usage.ts`                                                       | prints output, exit 0             |
| Find un-migrated calls | `grep -rn 'createContainer(' README.md examples/ test/ src/ \| grep -v 'function createContainer' \| grep -v 'createContainer({'` | no output when migration complete |

## Scope

**In scope** (the only files you modify):
- `src/module-composition/composition.ts` — new signature + body.
- `src/module-composition/types.ts` — add `ContainerConfig<Parts>`; import `ContainerOptions`.
- `src/module-composition/index.ts` — export `ContainerConfig` and `ContainerOptions`.
- `examples/public-api-usage.ts` — migrate 2 calls.
- `README.md` — migrate 7 snippets + the `### createContainer` API section (line ~496) + add an options example.
- `test/runs/module-composition.test.ts` — migrate 29 calls + add the runtime `onDisposeError` test.
- `test/runs/types.test.ts` — migrate 2 calls + add config-shape assertions.
- `package.json` — bump `version` `1.1.0` → `1.2.0` (see Step 7; defer if you do releases separately).

**Out of scope** (do NOT touch):
- `examples/engine.ts` — uses raw `Container`; unaffected.
- `src/container/` and `src/types.ts`'s `ContainerOptions` **semantics** — only
  surface the existing hook; do not broaden it to observe normal dispose/unload
  failures (that is a separate, deferred question).
- `STATUS.md` — its "Public API now" snippet will become stale; note it in the PR
  but do not rewrite STATUS here (it is separately known-stale).
- Adding new `ContainerOptions` fields.

## Git workflow

- Branch: you are on `improvements/1.2.0`; work there or branch `advisor/006-container-options` off it.
- Conventional Commits; e.g. `feat: accept options via createContainer({ options, parts }) (breaking)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `ContainerConfig` type

In `src/module-composition/types.ts`, import `ContainerOptions` from `../types`
(add it to the existing `import type { ... } from "../types"`) and add:

```ts
/** Input to createContainer: the modules/overrides to compose, plus optional
 *  root ContainerOptions (e.g. onDisposeError). Scopes inherit these options. */
export interface ContainerConfig<Parts extends readonly ContainerPart[]> {
  readonly options?: ContainerOptions;
  readonly parts: Parts;
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Rewrite `createContainer`

In `src/module-composition/composition.ts`, replace the variadic signature with the
config form and thread the options into the engine. Import `ContainerConfig` from
`./types` (it is re-exported there). The body is the same wiring logic over
`config.parts`:

```ts
export function createContainer<const Parts extends readonly ContainerPart[]>(
  config: ContainerConfig<Parts>,
): ContainerView<Parts> {
  const { options = {}, parts } = config;

  const exposed: ComposedModuleInternals[] = [];
  const overrides: OverrideInternals[] = [];
  for (const part of parts) {
    const overrideInternals = findOverrideInternals(part as ModuleOverride<string>);
    if (overrideInternals) overrides.push(overrideInternals);
    else exposed.push(requireModuleInternals(part as ComposedModule<string, ModuleEntryMap>));
  }

  const wiring = wiringOf(exposed);

  for (const override of overrides) {
    if (!wiring.has(override.targetModule)) {
      throw new InvalidModuleUseError(
        `Override targets module '${override.targetModule.name}' which is not part of this container's wiring.`,
      );
    }
  }

  const container = new Container(options);   // options now threaded into the root
  for (const wiringModule of wiring) {
    container.load(wiringModule.kernelModule);
  }
  for (const override of overrides) {
    container.load(buildOverrideKernelModule(override), { override: true });
  }

  return buildContainerView<Parts>(container, exposed);
}
```

**Verify**: `bun run typecheck` → exit 0. (Call sites elsewhere will not typecheck
yet — that is expected until Steps 4–6. `bun run typecheck` covers only `src/`,
which should be green now.)

### Step 3: Export `ContainerOptions` and `ContainerConfig` publicly

In `src/module-composition/index.ts`:
- Add `ContainerConfig` to the `export type { ... } from "./types"` line.
- Add `export type { ContainerOptions } from "../types";`.

Both flow to the package root because `src/index.ts` does
`export * from "./module-composition"` — no edit to `src/index.ts` is required.

**Verify**:
- `bun run typecheck` → exit 0.
- `grep -rn 'ContainerOptions\|ContainerConfig' src/module-composition/index.ts` →
  shows both exported.

### Step 4: Migrate `examples/public-api-usage.ts`

Apply the transform `createContainer(a, b, c)` → `createContainer({ parts: [a, b, c] })`
to both calls (overrides go in `parts` too). Then add one example demonstrating
options, e.g. near the existing usage:

```ts
const app = createContainer({
  options: { onDisposeError: (e) => console.error("orphan dispose failed:", e) },
  parts: [infraModule, dataModule, actionsModule],
});
```

**Verify**:
- `bun run typecheck:examples` → exit 0.
- `bun examples/public-api-usage.ts` → runs, exit 0.

### Step 5: Migrate the tests + add the runtime `onDisposeError` test

1. In `test/runs/module-composition.test.ts` and `test/runs/types.test.ts`, migrate
   every `createContainer(...)` call to `createContainer({ parts: [...] })`.
2. Add a runtime test in `test/runs/module-composition.test.ts` proving the
   composition layer threads `onDisposeError`. **Model it after the engine test at
   `test/runs/disposal.test.ts:127`** ("onDisposeError observes orphan disposal
   failure"), but go through `createContainer`. Shape:

```ts
it("createContainer threads onDisposeError to observe orphan disposal failures", async () => {
  let hookError: unknown = null;
  const Infra = createModule("Infra", (m) =>
    m.singleAsync(
      "resource",
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { close: () => { throw new Error("orphan-dispose"); } };
      },
      { dispose: (x) => x.close() },
    ),
  );
  const app = createContainer({ options: { onDisposeError: (e) => { hookError = e; } }, parts: [Infra] });

  const pending = app.Infra.resource();
  pending.catch(() => {}); // caller sees DisposedContainerError; not asserted here
  await new Promise((r) => setTimeout(r, 5));
  await app.dispose();                 // evicts the token while resolution is in flight
  await new Promise((r) => setTimeout(r, 10));

  expect(hookError instanceof Error && (hookError as Error).message === "orphan-dispose").toBeTruthy();
});
```

Use whatever `delay`/timing helpers that file already uses if present (check its
imports); otherwise inline `setTimeout` as above.

**Verify**:
- `bun run typecheck:test` → exit 0 (all migrated assertions compile).
- `bun run test` → all pass, including the new test.

### Step 6: Add config-shape type assertions to `test/runs/types.test.ts`

After migrating the existing assertions, add positive + negative coverage of the
new signature:

```ts
it("createContainer accepts a config object and infers namespaces from parts", () => {
  const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => ({ info() {} })));

  const a = createContainer({ parts: [Infra] });
  expectTypeOf(a.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();

  const b = createContainer({ options: { onDisposeError() {} }, parts: [Infra] });
  expectTypeOf(b.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();

  // @ts-expect-error parts is required
  createContainer({});
  // @ts-expect-error unknown option key is rejected
  createContainer({ options: { nope: true }, parts: [Infra] });
});
```

**Verify**: `bun run typecheck:test` → exit 0 (the `@ts-expect-error` lines must
each suppress a real error; if any reports "Unused '@ts-expect-error'", that case
does not error as expected — STOP and report).

### Step 7: Migrate the README + (optional) version bump

1. In `README.md`, update every `createContainer(...)` snippet (7) to the config
   form, and rewrite the `### createContainer` API section (the signature at line
   ~496 `function createContainer(...parts): ContainerView;`) to:
   ```ts
   function createContainer<Parts>(config: { options?: ContainerOptions; parts: Parts }): ContainerView<Parts>;
   ```
   Add a short subsection documenting `options.onDisposeError` (observes orphan
   disposal failures only; normal dispose/unload failures still throw
   `AggregateError`).
2. In `package.json`, bump `"version": "1.1.0"` → `"1.2.0"`. (If your release
   process sets the version separately, skip this and note it in the PR.)

**Verify**:
- `grep -rn 'createContainer(' README.md examples/ test/ src/ | grep -v 'function createContainer' | grep -v 'createContainer({'`
  → **no output** (every call site uses the config form).
- The README no longer shows `createContainer(...parts)` as the signature.

### Step 8: Full gate

**Verify** (all must pass):
- `bun run quality` → exit 0 (lint, format, `typecheck:all` incl. examples, tests + coverage).
- `bun examples/public-api-usage.ts` and `bun examples/engine.ts` → exit 0.

## Test plan

- Migrated: all existing `createContainer` assertions/tests now use the config form.
- New runtime test (`module-composition.test.ts`): composition-level
  `onDisposeError` observes an orphan disposal failure (modeled on
  `disposal.test.ts:127`).
- New type assertions (`types.test.ts`): config object infers namespaces with and
  without `options`; `parts` is required; unknown option keys rejected.
- Enforcement: `bun run typecheck:test` (type assertions) + `bun run test` (runtime).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `createContainer` takes a single `ContainerConfig<Parts>` arg; the variadic form is gone.
- [ ] `new Container(options)` is used (options threaded); `grep -n 'new Container()' src/module-composition/composition.ts` → no match.
- [ ] `ContainerOptions` and `ContainerConfig` are exported from the package root (verify: a test/example imports `ContainerOptions` from `"../src"` and it typechecks).
- [ ] `grep -rn 'createContainer(' README.md examples/ test/ src/ | grep -v 'function createContainer' | grep -v 'createContainer({'` → no output.
- [ ] `bun run quality` exits 0; `bun examples/public-api-usage.ts` exits 0.
- [ ] New composition-level `onDisposeError` test exists and passes; new config-shape type assertions exist and are enforced by `typecheck:test`.
- [ ] `package.json` version is `1.2.0` (or PR notes the version is set at release).
- [ ] `git status` shows only the in-scope files changed (no `examples/engine.ts`, no `src/container/*`, no `STATUS.md`).
- [ ] `plans/README.md` status row for 006 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- After Step 2, `src/` does not typecheck for a reason other than downstream call
  sites (those are migrated in later steps) — the new signature has a problem.
- A migrated `@ts-expect-error` in the type tests reports "Unused" (the case no
  longer errors), or a positive `expectTypeOf` fails — the public types changed
  unexpectedly; report rather than weakening the assertion.
- The new `onDisposeError` test does not observe the hook firing — the option is
  not threading through; report (do not loosen the assertion).
- You find a `createContainer(` call outside the four files in the migration table
  (e.g. a new test added since this plan) — migrate it too and note it; if it is in
  an out-of-scope file, STOP.
- The example or any snippet needs a non-mechanical change to compile (a real API
  mismatch beyond the call shape) — report it.

## Maintenance notes

For whoever owns this next:
- This is a breaking change shipping in 1.2.0 by maintainer decision (migration is
  a one-line edit per call site). Reviewer should confirm the config key names
  (`options`/`parts`) are the intended public surface before merge.
- `STATUS.md`'s "Public API now" example still shows `createContainer(UseCases)` —
  update it in the separate STATUS pass.
- Open questions deliberately deferred (from the spike): broadening `onDisposeError`
  to observe normal dispose/unload failures; whether to design further
  `ContainerOptions` fields now. Neither blocks this change — the config object
  leaves room for both.
- Because scopes inherit options at the engine layer, no per-scope options API is
  needed; if one is ever wanted, it goes on the scope view, not here.
