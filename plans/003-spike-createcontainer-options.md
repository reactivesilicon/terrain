# Plan 003: Spike — design `createContainer(options, ...parts)` for `ContainerOptions`

> **Executor instructions**: This is a **design spike, not an implementation**.
> Your deliverable is a written design document. Do **not** modify any file under
> `src/`. Follow the steps, then write the analysis file described in Step 5. If a
> STOP condition occurs, stop and report. When done, update the status row for
> this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 8df145a..HEAD -- src/module-composition/composition.ts src/types.ts src/container/container.ts src/module-composition/types.ts`
> If any changed since this plan was written, compare the "Current state" excerpts
> below against the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: S (investigation + write-up; no production code)
- **Risk**: LOW (produces a document; changes no behavior)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `8df145a`, 2026-06-20

## Why this matters

The engine's `Container` accepts `ContainerOptions`, whose only field is
`onDisposeError` — a hook for observing disposal failures of **orphaned** in-flight
instances (resolutions that finished after `dispose()`/`unload()` had already
evicted their token, so the result can't be cached and is disposed immediately).
But the public composition API constructs the container with `new Container()` and
no options, so **`onDisposeError` is unreachable through the public API entirely**:
those orphan-disposal errors are silently swallowed with no way for an application
to observe them. `STATUS.md` lists `createContainer(options, ...parts)` as the
natural future shape. Because this changes the public API surface, the repo's
convention (per `STATUS.md` "Conventions to uphold": _discuss design/naming before
code when the change affects public API shape_) is to design it first. This spike
produces that design so a follow-up implementation plan can be written with the
shape already decided.

## Current state

Files involved (read all of these during the spike):

- `src/module-composition/composition.ts` — `createContainer` lives here.
- `src/types.ts` — `ContainerOptions` definition + its doc comment.
- `src/container/container.ts` — how the engine stores and uses options.
- `src/module-composition/types.ts` — `ContainerPart`, `ContainerView`, the
  `const Parts` tuple typing that drives namespace exposure.
- `src/module-composition/module-internals.ts` — `requireModuleInternals` /
  `findOverrideInternals`, the runtime brand checks used to classify parts.
- `src/module-composition/container-views.ts` — `buildScopeMethod` (how scopes are
  created from the container).

`createContainer` today (`composition.ts:182-210`, abbreviated):

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
  // ...override-target validation...
  const container = new Container(); // <-- no options passed
  for (const wiringModule of wiring) container.load(wiringModule.kernelModule);
  for (const override of overrides) container.load(buildOverrideKernelModule(override), { override: true });
  return buildContainerView<Parts>(container, exposed);
}
```

`ContainerOptions` (`src/types.ts:81-88`) — note it has exactly one field, and its
semantics are narrow:

```ts
export interface ContainerOptions {
  /** Observe disposal errors for ORPHANED in-flight instances only — i.e. a
   *  resolution that completed after dispose()/unload() had already evicted its
   *  token, so its result can't be cached and is disposed immediately.
   *  Disposal failures during normal dispose()/unload() are NOT reported here;
   *  they surface via the AggregateError those methods throw. */
  onDisposeError?: (error: unknown) => void;
}
```

How the engine threads options (`src/container/container.ts`):

```ts
constructor(options: ContainerOptions = {}) {            // line 71-73
  this.options = options;
}

createScope(): Container {                                // line 237-243
  this.assertTreeUsable();
  const scope = new Container(this.options);              // <-- scopes INHERIT options
  scope.parent = this;
  this.children.add(scope);
  return scope;
}

notifyDisposeError(error: unknown): void {                // line 401-407
  try {
    this.options.onDisposeError?.(error);
  } catch { /* hooks are observational */ }
}
```

Part classification is brand-based, not structural (`module-internals.ts`):

- `findOverrideInternals(x)` → `OverrideInternals | undefined` (looks `x` up in a
  `WeakMap` keyed by override identity).
- `requireModuleInternals(x)` → throws `ForeignModuleError` if `x` is not a module
  created by `createModule` (looked up in a `WeakMap`).

So a plain options object (`{ onDisposeError }`) is neither a registered module nor
a registered override; passed where a part is expected today it would throw
`ForeignModuleError`. This matters for runtime detection (Step 3).

The typed entry tuple (`src/module-composition/types.ts`):

- `ContainerPart = ComposedModule<...> | ModuleOverride<...>` (line 187), both
  branded interfaces.
- `createContainer<const Parts extends readonly ContainerPart[]>(...)` uses the
  `const` modifier so the literal tuple of parts is preserved and drives
  `Namespaces<Parts>` / `ContainerView<Parts>`. Any new overload must preserve this
  inference, or namespace exposure breaks.

Convention to honor (inline from `STATUS.md`): _"Discuss design/naming before code
when the change affects public API shape"_ and _"Prefer compile-time enforcement
with runtime backstops for untyped callers."_ The design must respect both.

## Commands you will need

| Purpose                    | Command                                    | Expected                        |
| -------------------------- | ------------------------------------------ | ------------------------------- |
| Read the cited source      | (open the files listed above)              | —                               |
| Optional typing experiment | `bunx tsc --noEmit <scratch file in /tmp>` | your experiment compiles or not |
| Confirm no src changes     | `git status --short src/`                  | no output at the end            |

## Scope

**In scope** (the only file you create):

- `plans/003-createcontainer-options-design.md` (the design write-up — create it).

**Out of scope** (do NOT modify):

- Anything under `src/`, `test/`, `examples/`. This spike writes a design, not code.
- Do not change `package.json`, configs, or CI.
- If you build a TypeScript experiment to validate a typing approach, put it under
  `/tmp` (outside the repo) and delete it when done — never under `src/`.

## Git workflow

- Branch: `advisor/003-spike-container-options`.
- Commit message style is Conventional Commits. Use e.g.
  `docs: design proposal for createContainer options`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the gap

Read `composition.ts:182-210` and `types.ts:81-88`. Confirm in your own words that
`new Container()` is called with no arguments and that `onDisposeError` is therefore
not reachable from any public entry point. Search to be sure no other public path
sets options: `grep -rn "new Container(" src/` — every call site should be either
this one (no args) or `createScope()` (passes `this.options`).

**Verify**: `grep -rn "new Container(" src/` → exactly the call sites you can
account for (composition root with no args; `createScope` with `this.options`).

### Step 2: Enumerate candidate API shapes

Draft at least these three shapes, each with a short code sketch and pros/cons:

A. **Leading-options overload** — `createContainer(options, ...parts)` plus the
existing `createContainer(...parts)`. Closest to what `STATUS.md` suggests.
B. **Trailing builder** — `createContainer(...parts).withOptions(options)` or an
options-accepting method on the returned view before first use.
C. **Single config object** — `createContainer({ parts: [...], options })`.

For each, note impact on the `const Parts` tuple inference (Step 4) and on
backward compatibility (the existing rest call must keep working unchanged).

### Step 3: Analyze runtime detection (only relevant to shape A)

For shape A, the runtime must distinguish a leading options object from a part.
Document the options and their risks:

- **Brand the options** (e.g. require callers to pass a `containerOptions({...})`
  wrapper that sets a private brand) — unambiguous, but adds API surface.
- **Structural sniff** — treat `parts[0]` as options if it is neither a registered
  module (`requireModuleInternals` would throw) nor an override
  (`findOverrideInternals` returns undefined). Risk: a future `ContainerPart` kind
  that is also a plain object could be misclassified; and a user typo (passing a
  non-module object intending it as a part) would be silently read as options
  instead of throwing `ForeignModuleError`.
  Recommend one and say why, consistent with _"runtime backstops for untyped callers"_.

### Step 4: Validate the type-level behavior

The load-bearing constraint is that `createContainer`'s `const Parts extends
readonly ContainerPart[]` inference still produces the exact tuple that
`ContainerView<Parts>` needs (namespace exposure depends on it). For your
recommended shape, build a minimal scratch experiment under `/tmp` (a `.ts` file
that imports from this repo's `src` via absolute path, or copies the relevant
signatures) and confirm:

- the existing `createContainer(ModuleA, ModuleB)` still infers namespaces `A` & `B`;
- the new options form still infers the same namespaces;
- overload resolution is unambiguous when the first part is a module, when it is an
  override, and when `parts` is empty.

Record what you tried and the result. If the typed form proves ambiguous or
degrades inference, that negative result **is** the key finding — write it up; do
not force a fragile signature.

**Verify**: your scratch experiment compiles (or you have documented precisely why
the typed shape cannot be made clean). Delete the scratch file:
`rm /tmp/<your-experiment>.ts`.

### Step 5: Write the design document

Create `plans/003-createcontainer-options-design.md` with these sections:

1. **Problem** — the unreachable `onDisposeError`, in 3–5 sentences.
2. **Current wiring** — how options flow in the engine (constructor → `createScope`
   inheritance → `notifyDisposeError`), so the reader knows scopes already inherit
   options once the root has them.
3. **Candidate shapes** — A/B/C from Step 2, each with a code sketch and trade-offs.
4. **Runtime detection** — the Step 3 analysis and your recommendation.
5. **Type-level findings** — the Step 4 experiment and result (compiles / does not).
6. **Scope inheritance** — confirm composition-layer scopes (`buildScopeMethod` →
   `createScope()`) will inherit options automatically once the root carries them,
   citing `container.ts:237-243`.
7. **Backward compatibility** — explicit statement that `createContainer(...parts)`
   is unchanged.
8. **Recommendation** — one shape, chosen, with the reasoning.
9. **Open questions for the maintainer** — at minimum: (a) is exposing the existing
   narrow `onDisposeError` enough, or should the composition layer offer a broader
   disposal-error hook? (b) any naming concerns on the chosen surface? (c) should
   future `ContainerOptions` fields be considered now to avoid a second API change?
10. **Proposed follow-up** — a one-paragraph sketch of the implementation plan this
    spike unblocks (which files, roughly), explicitly deferred to maintainer sign-off.

Optionally include a non-applied proof-of-concept diff as a fenced code block — but
do not apply it to `src/`.

**Verify**: the file exists and contains all ten section headings:
`grep -c '^#' plans/003-createcontainer-options-design.md` → at least 10.

## Test plan

No code is produced, so there are no unit tests. "Verification" is structural:
the design document exists, contains the ten required sections, and no `src/` file
was modified.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `plans/003-createcontainer-options-design.md` exists with all ten sections from Step 5.
- [ ] The document names a single recommended API shape and lists open questions for the maintainer.
- [ ] `git status --short src/ test/ examples/` → no output (nothing in those trees was changed).
- [ ] No scratch experiment files remain in the repo (`git status --short` shows only the new design doc and, if you branched, nothing under `src/`).
- [ ] `plans/README.md` status row for 003 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- Reading the code shows options ARE already reachable through some public path you
  missed (the premise is wrong) — report where.
- The cited source does not match the "Current state" excerpts (drift since this
  plan was written).
- You find yourself about to edit a file under `src/` to "just implement it" — this
  is a design spike; stop and report that implementation is ready to be planned
  instead.
- The typed shape cannot be made unambiguous AND none of the alternative shapes
  (B/C) are acceptable — report this as the finding; the maintainer decides.

## Maintenance notes

For whoever owns this next:

- This spike unblocks an implementation plan; it deliberately produces no code so
  the public-API shape can be reviewed first (repo convention).
- The narrow semantics of `onDisposeError` (orphan-disposal only) are easy to
  misread — whatever surface is chosen should document that it does **not** observe
  normal `dispose()`/`unload()` failures (those throw `AggregateError`).
- Because the engine already inherits options into child scopes, exposing options
  at the root is sufficient to make scoped disposal observability work too — no
  per-scope options API is needed in the first iteration.
