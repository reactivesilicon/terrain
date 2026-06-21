# Plan 008: Relax module names — any identifier except the reserved view methods

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Depends on plan 007 being DONE** (null-prototype views). Without it, a module
> named `toString`/`constructor`/`__proto__` — all valid identifiers this plan
> newly allows — would collide with `Object.prototype` on the container view. If
> the views are not yet null-prototype, STOP: land 007 first.
>
> **Drift check (run first)**:
> `git diff --stat f283d71..HEAD -- src/validations/name-validations.ts src/errors.ts src/module-composition/types.ts src/module-composition/composition.ts README.md test/runs/module-composition.test.ts test/runs/types.test.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW-MED (additive / non-breaking — every previously-valid PascalCase name still works; touches a public type + validator + several tests and docs)
- **Depends on**: plans/007-harden-accessor-namespace-nullproto.md
- **Category**: direction
- **Planned at**: commit `f283d71`, 2026-06-21

## Why this matters

Module names are currently forced to **PascalCase** (`^[A-Z][A-Za-z0-9_$]*$`). The
rule exists so module namespaces (on the container view) can never collide with the
view's lowercase methods `scope`/`start`/`dispose` — *"no reserved-word list to
maintain."* The maintainer wants consumers to name modules freely (e.g. `infra`,
`userService`) and is fine keeping only the genuine view methods reserved. After
plan 007 made the view objects null-prototype, the **only** names that can collide
are those three methods — so the PascalCase straightjacket can be replaced with a
tiny, explicit reserved set. This is **non-breaking**: PascalCase names remain
valid; the change only *widens* what's accepted. Entry names already allow any
identifier and are unchanged here.

## Current state

### `src/validations/name-validations.ts`

```ts
import { InvalidModuleNameError } from "../errors";

const PASCAL_CASE_IDENTIFIER = /^[A-Z][A-Za-z0-9_$]*$/;
const IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name);
}

export function assertModuleName(name: string): void {
  if (!PASCAL_CASE_IDENTIFIER.test(name)) {
    throw new InvalidModuleNameError(name);
  }
}
```

### `src/errors.ts` — `InvalidModuleNameError` (message mentions PascalCase)

```ts
export class InvalidModuleNameError extends DIError {
  constructor(name: string) {
    super(
      `Module name '${name}' must be PascalCase (an identifier starting with an uppercase letter); ` +
        `the container view's lowercase API can then never collide with a module namespace.`,
    );
    this.name = "InvalidModuleNameError";
  }
}
```

### `src/module-composition/types.ts` (lines ~222-225) — the compile-time guard

```ts
/** Module names must be PascalCase. The container view's API (scope, start,
 *  dispose — and anything added later) is lowercase, so namespaces and
 *  methods can never collide, with no reserved-word list to maintain. */
export type PascalCase<Name extends string> = Name extends Capitalize<Name> ? Name : never;
```

`PascalCase` is **internal** (not re-exported from `src/module-composition/index.ts`
or `src/index.ts`), so renaming it is safe.

### `src/module-composition/composition.ts` — uses of `PascalCase`

- Imports `PascalCase` (line ~45).
- Two overload signatures take `moduleName: PascalCase<ModuleName>` (lines ~112, ~122).
- The runtime impl calls `assertModuleName(moduleName)` (line ~133).

### Existing tests (`test/runs/module-composition.test.ts`)

```ts
// lines 356-362
it("module names must be PascalCase so they can never shadow the view API", () => {
  expect(() => createModule("scope" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
  expect(() => createModule("dispose" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
  expect(() => createModule("9Lives" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
  expect(() => createModule("My Mod" as never, (m) => m.single("x", () => 1))).toThrowError(/must be PascalCase/);
});

// lines 364-372
it("compile-time: lowercase module names are rejected", () => {
  void function compileOnly() {
    // @ts-expect-error module names must be PascalCase
    createModule("infra", (m) => m.single("x", () => 1));
    // @ts-expect-error a module literally named after a view method cannot exist
    createModule("start", (m) => m.single("x", () => 1));
  };
  expect(true).toBe(true);
});
```

The test file currently imports `InvalidEntryNameError` (not `InvalidModuleNameError`)
on line 3.

### README naming claims to update

`grep -n 'PascalCase\|lowercase' README.md` finds: the Modules section paragraph
(~line 160, "Module names must be PascalCase…"), and two Guardrails bullets (~line
383 "Lowercase literal module names are rejected"; ~line 387 "Module names must be
PascalCase identifiers (`InvalidModuleNameError`)").

## Commands you will need

| Purpose            | Command                                       | Expected                       |
|--------------------|-----------------------------------------------|--------------------------------|
| Typecheck all      | `bun run typecheck:all`                       | exit 0                         |
| Composition tests  | `bun run test -- module-composition`          | pass                           |
| Full gate          | `bun run quality`                             | exit 0                         |
| No stale PascalCase | `grep -rni 'pascalcase' src/ README.md`      | no matches when done           |

## Scope

**In scope** (the only files you modify):
- `src/validations/name-validations.ts` — new rule + reserved set.
- `src/errors.ts` — `InvalidModuleNameError` message.
- `src/module-composition/types.ts` — replace `PascalCase` with `PublicModuleName` + `ReservedViewWord`.
- `src/module-composition/composition.ts` — import rename + the two param types.
- `test/runs/module-composition.test.ts` — rewrite the two tests + add the guard test.
- `test/runs/types.test.ts` — add type assertions.
- `README.md` — update the naming claims.

**Out of scope** (do NOT touch):
- Accessor / namespace / view internals — plan 007 owns those.
- Entry-name validation (`isIdentifierName` for entries stays; entries are already
  free within identifiers).
- Adding any reserved name beyond `scope`/`start`/`dispose` — plan 007 made
  `Object.prototype` names safe, so they must NOT be reserved.
- `STATUS.md` — its "Public API now" prose is handled in the separate STATUS pass;
  note it but do not edit here.

## Git workflow

- Branch: `advisor/008-relax-module-names` off the 007 branch (or main once 007 merges).
- Conventional Commits; e.g. `feat: allow any-identifier module names except reserved view methods`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: New module-name rule + reserved set

In `src/validations/name-validations.ts`, remove `PASCAL_CASE_IDENTIFIER`, add a
single source of truth for the reserved names, and rewrite `assertModuleName`:

```ts
import { InvalidModuleNameError } from "../errors";

const IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The container view's own method names. A module namespace sits on the view
 *  next to these, so a module may not take one of them. Kept in sync with the
 *  view by the guard test in test/runs/module-composition.test.ts. */
export const RESERVED_MODULE_NAMES: ReadonlySet<string> = new Set(["scope", "start", "dispose"]);

export function isIdentifierName(name: string): boolean {
  return IDENTIFIER_NAME.test(name);
}

export function assertModuleName(name: string): void {
  if (!isIdentifierName(name) || RESERVED_MODULE_NAMES.has(name)) {
    throw new InvalidModuleNameError(name);
  }
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Update the error message

In `src/errors.ts`, change `InvalidModuleNameError`'s message to state the new rule:

```ts
super(
  `Module name '${name}' must be a valid identifier (letters, digits, _ or $, not starting with a digit) ` +
    `and not a reserved view-method name (scope, start, dispose).`,
);
```

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Replace the `PascalCase` type with a reserved-word guard

In `src/module-composition/types.ts`, replace the `PascalCase` definition and its
comment with:

```ts
/** The container view's reserved method names — a module namespace cannot take
 *  one (it would shadow the method on the view). Keep in sync with ContainerView
 *  / ScopeView and RESERVED_MODULE_NAMES (guarded by a test). */
export type ReservedViewWord = "scope" | "start" | "dispose";

/** A module name may be any identifier except a reserved view-method name.
 *  Identifier-ness is enforced at runtime (assertModuleName); only the
 *  reserved-word guard needs to be compile-time. */
export type PublicModuleName<Name extends string> = Name extends ReservedViewWord ? never : Name;
```

In `src/module-composition/composition.ts`, change the import `PascalCase` →
`PublicModuleName`, and the two `moduleName: PascalCase<ModuleName>` →
`moduleName: PublicModuleName<ModuleName>`.

**Verify**: `bun run typecheck` → exit 0; `grep -rn 'PascalCase' src/` → no matches.

### Step 4: Rewrite the two existing tests + add a guard test

In `test/runs/module-composition.test.ts`:

1. Add `InvalidModuleNameError` to the imports on line 3.
2. Replace the test at lines 356-362 with:

```ts
it("module names may be any identifier except the reserved view-method names", () => {
  for (const reserved of ["scope", "start", "dispose"]) {
    expect(() => createModule(reserved as never, (m) => m.single("x", () => 1))).toThrowError(InvalidModuleNameError);
  }
  // non-identifiers still rejected
  expect(() => createModule("9Lives" as never, (m) => m.single("x", () => 1))).toThrowError(InvalidModuleNameError);
  expect(() => createModule("My Mod" as never, (m) => m.single("x", () => 1))).toThrowError(InvalidModuleNameError);
  // lowercase / camelCase identifiers now accepted
  expect(() => createModule("infra", (m) => m.single("x", () => 1))).not.toThrow();
  expect(() => createModule("userService", (m) => m.single("x", () => 1))).not.toThrow();
});
```

3. Replace the test at lines 364-372 with:

```ts
it("compile-time: reserved view-method module names are rejected; other identifiers allowed", () => {
  void function compileOnly() {
    createModule("infra", (m) => m.single("x", () => 1)); // ok: lowercase identifier
    // @ts-expect-error 'start' is a reserved view-method name
    createModule("start", (m) => m.single("x", () => 1));
    // @ts-expect-error 'dispose' is a reserved view-method name
    createModule("dispose", (m) => m.single("x", () => 1));
  };
  expect(true).toBe(true);
});
```

4. Add a guard test that keeps the reserved set honest against the actual view:

```ts
it("the reserved module names equal the container view's own method names", () => {
  const M = createModule("M", (m) => m.single("x", () => 1));
  const app = createContainer({ parts: [M] }); // use createContainer(M) if plan 006 not landed
  const methodKeys = Object.keys(app).filter((k) => typeof (app as Record<string, unknown>)[k] === "function");
  expect(new Set(methodKeys)).toEqual(new Set(["scope", "start", "dispose"]));
});
```

**Verify**: `bun run typecheck:test` → exit 0 (each `@ts-expect-error` suppresses a
real error — none reported "Unused"); `bun run test -- module-composition` → pass.

### Step 5: Add type assertions (`test/runs/types.test.ts`)

```ts
it("module names: any identifier accepted, reserved view words rejected", () => {
  const infra = createModule("infra", (m) => m.single("logger", (): Logger => ({ info() {} })));
  const app = createContainer({ parts: [infra] }); // createContainer(infra) if 006 not landed
  expectTypeOf(app.infra.logger()).toEqualTypeOf<Logger>();
  expectTypeOf(app.infra.logger()).not.toBeAny();

  // @ts-expect-error 'dispose' is a reserved view-method name
  createModule("dispose", (m) => m.single("x", () => 1));
});
```

**Verify**: `bun run typecheck:test` → exit 0.

### Step 6: Update the README naming claims

Update the three spots `grep -n 'PascalCase\|lowercase' README.md` finds so they
state the new rule, e.g.:

- Modules section: "**Module names may be any identifier except the view's reserved
  method names** (`scope`, `start`, `dispose`); **entry names may be any
  identifier.** The reserved list is exactly the view's own methods, checked at
  compile time and re-checked at runtime (`InvalidModuleNameError`,
  `InvalidEntryNameError`)."
- Guardrails: replace "Lowercase literal module names are rejected" with "**Reserved
  module names** (`scope`/`start`/`dispose`) are rejected at compile time", and
  "Module names must be PascalCase identifiers" with "**Module names must be
  identifiers and not reserved view names**".

Keep existing PascalCase example modules (`Infra`, `Data`, …) as-is — they remain
valid; you are only correcting the prose, not the snippets.

**Verify**: `grep -rni 'pascalcase' src/ README.md` → no matches.

### Step 7: Full gate

**Verify** (all must pass):
- `bun run quality` → exit 0.
- `bun examples/public-api-usage.ts` and `bun examples/engine.ts` → exit 0.

## Test plan

- Rewritten: the two PascalCase tests now assert the reserved-word rule and that
  lowercase identifiers are accepted (runtime + compile-time).
- New: a guard test pinning `RESERVED_MODULE_NAMES`/`ReservedViewWord` to the view's
  actual method keys, so adding a view method without updating the reserved set
  fails CI.
- New: type assertions that a lowercase module name infers its namespace and a
  reserved name is a type error.
- Enforcement: `bun run quality` (includes `typecheck:test`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn 'PascalCase' src/` and `grep -rni 'pascalcase' README.md` → no matches.
- [ ] `RESERVED_MODULE_NAMES` exists in `name-validations.ts`; `ReservedViewWord` + `PublicModuleName` exist in `module-composition/types.ts`; `composition.ts` uses `PublicModuleName`.
- [ ] `createModule("userService", …)` and `createModule("infra", …)` are accepted at runtime and compile time; `createModule("dispose", …)` is rejected at both.
- [ ] The guard test asserting the reserved set equals the view's method keys passes.
- [ ] `bun run quality` exits 0; both examples exit 0.
- [ ] `git status` shows only the in-scope files changed (no accessor/namespace/view files — those are plan 007).
- [ ] `plans/README.md` status row for 008 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 007 is not landed (views are still plain `{}` / object-literal spreads) —
  a module named `toString`/`__proto__` would corrupt the view; STOP and land 007.
- A migrated `@ts-expect-error` reports "Unused" (the reserved-word type guard isn't
  firing) or a positive assertion fails — the type change is wrong; report it.
- The guard test finds the view's method keys are not exactly
  `{scope, start, dispose}` — the reserved set and the view have drifted; reconcile
  and report (do not just edit the set to match without understanding why).
- You are tempted to reserve `Object.prototype` names (`toString`, `constructor`,
  `__proto__`, …) — you should not need to after 007; if you do, 007's hardening is
  incomplete. STOP and report.

## Maintenance notes

For whoever owns this next:
- **The reserved list is now a maintained invariant.** Any new method added to the
  container view (beyond `scope`/`start`/`dispose`) MUST be added to both
  `RESERVED_MODULE_NAMES` and `ReservedViewWord`; the guard test enforces this.
- This is non-breaking (PascalCase names still valid), so it can ship in a minor
  (1.2.0/1.3.0). `STATUS.md`'s naming prose should be refreshed in the STATUS pass.
- If the maintainer later wants Tier 2 (arbitrary non-identifier names like
  `"my-module"` via bracket access), the runtime change is to drop the
  `isIdentifierName` requirement from `assertModuleName` (keeping the reserved-word
  check) and the entry check; the type side already supports arbitrary string keys.
  That trades away the dot-access guarantee, so it was deliberately deferred.
