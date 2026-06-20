# Plan 004: Pin the public type contract with positive `expectTypeOf` assertions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 8df145a..HEAD -- src/module-composition/ src/accessors.ts test/runs/module-composition.test.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (adds tests only; touches no production code)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `8df145a`, 2026-06-20

## Why this matters

The public API's typed contract is enforced today only in the *negative*: there
are 31 `@ts-expect-error` tests asserting that wrong usage fails to compile
(sync providers can't see async entries, PascalCase enforcement, override
name/mode checks, forward-reference bans, etc.). There are **zero positive type
assertions** — nothing asserts that `app.Infra.logger()` resolves to exactly
`Logger` (and not `any`). That asymmetry is a real gap: the composition builder
erases provider types through `as any` / `as unknown as` casts
(`composition.ts:63,82,96`; `module-override/build-module-overrides.ts:70,80,99`),
and if one of those casts ever widened an accessor's type to `any`, **no existing
test would catch it** — an `any` silently satisfies every `@ts-expect-error` and
accepts every value. This plan adds positive `expectTypeOf` assertions that pin
the observable public types, so an `any`-leak (or any return-type drift) through
that builder seam fails the gate. It is also the safety net that plan 005 (cast
containment refactor) depends on.

## Current state

How type-level testing works in this repo (read before writing tests):

- **Negative assertions** use `// @ts-expect-error` inline in regular `.test.ts`
  files. Examples live in `test/runs/module-composition.test.ts` (lines ~225,
  332, 477–527) and `test/runs/accessors.test.ts` (lines ~113–115).
- Those files are typechecked by `bun run typecheck:test` (`tsc -p
  tsconfig.test.json`, which `include`s `["src", "test"]`). That command is part
  of the `quality` gate. **This is the enforcement path for type assertions.**
- **Crucial gotcha**: `expectTypeOf(...).toEqualTypeOf<...>()` is a *no-op at
  runtime*. `vitest run` (a.k.a. `bun run test`) does **not** typecheck it and
  will report it as passing even when the types are wrong. A failing
  `expectTypeOf` assertion only surfaces as a **`tsc` error** under
  `bun run typecheck:test`. Verify these tests with `typecheck:test`, never with
  `vitest run` alone.

`expectTypeOf` is exported by the installed `vitest` (verified) — import it from
`"vitest"`.

The public entry point used by the tests:

```ts
// src/index.ts re-exports these:
import { createContainer, createModule } from "../../src";
```

Accessor typing rules to assert (from `src/module-composition/types.ts` and
`src/accessors.ts`):
- A **sync** entry `name` becomes accessor `() => T`.
- An **async** entry `name` becomes accessor `() => Promise<T>`.
- A provider's resolver exposes imported modules under their names
  (`r.Infra.logger()`) and the module's own earlier entries under its own name
  (`r.Data.rows()`), with the imported entry's exact value type.
- An **override** `.with(entry, provider)` infers `provider`'s return type as the
  original entry's value type (mode and name checked against the original).

Pattern to follow for constructing modules in tests: mirror the module shapes in
`test/runs/module-composition.test.ts` (small inline `interface` + class or
object literal providers).

## Commands you will need

| Purpose                       | Command                       | Expected on success                         |
|-------------------------------|-------------------------------|---------------------------------------------|
| Typecheck the type assertions | `bun run typecheck:test`     | exit 0, no errors (THIS enforces the tests) |
| Run the suite (no-op for types)| `bun run test`               | all tests pass, including the new file      |
| Full gate                     | `bun run quality`            | exit 0                                       |

## Scope

**In scope** (the only file you create):
- `test/runs/types.test.ts` (create)

**Out of scope** (do NOT modify):
- Any file under `src/` — this plan adds tests that observe the existing types;
  it must not change them. If an assertion does not hold, that is a finding to
  report (STOP), not a reason to edit `src/`.
- The existing test files — add a new file; do not edit the 31 negative tests.

## Git workflow

- Branch: `advisor/004-positive-type-assertions`.
- Conventional Commits; e.g. `test: pin public accessor/resolver types with expectTypeOf`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the type-assertion test file

Create `test/runs/types.test.ts`. Use `expectTypeOf` from `vitest`. Place
assertions inside `describe`/`it` blocks (so they also surface in the test list).
Cover the four groups below. The exact module shapes are illustrative — keep them
small; what matters is the assertions.

```ts
import { describe, expectTypeOf, it } from "vitest";
import { createContainer, createModule } from "../../src";

interface Logger {
  info(message: string): void;
}
interface UserRepo {
  find(id: string): string | null;
}

describe("public type contract (positive assertions)", () => {
  it("container accessors have exact sync/async return types — no any-leak", () => {
    const Infra = createModule("Infra", (m) =>
      m
        .single("logger", (): Logger => ({ info() {} }))
        .singleAsync("config", async () => ({ env: "prod" as const })),
    );
    const app = createContainer(Infra);

    expectTypeOf(app.Infra.logger).toEqualTypeOf<() => Logger>();
    expectTypeOf(app.Infra.logger()).toEqualTypeOf<Logger>();
    expectTypeOf(app.Infra.logger()).not.toBeAny();

    expectTypeOf(app.Infra.config).toEqualTypeOf<() => Promise<{ env: "prod" }>>();
    expectTypeOf(app.Infra.config()).resolves.toEqualTypeOf<{ env: "prod" }>();
    expectTypeOf(app.Infra.config()).not.toBeAny();
  });

  it("provider resolver namespaces carry imported + own-earlier entry types", () => {
    const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => ({ info() {} })));
    createModule("Data", { uses: [Infra] }, (m) =>
      m
        .single("rows", () => new Map<string, string>([["1", "Ada"]]))
        .single("userRepo", (r): UserRepo => {
          // imported module entry, exact type
          expectTypeOf(r.Infra.logger()).toEqualTypeOf<Logger>();
          expectTypeOf(r.Infra.logger()).not.toBeAny();
          // own earlier entry, exact type
          expectTypeOf(r.Data.rows()).toEqualTypeOf<Map<string, string>>();
          return { find: (id) => r.Data.rows().get(id) ?? null };
        }),
    );
  });

  it("the container view exposes namespaces plus lifecycle methods", () => {
    const Infra = createModule("Infra", (m) => m.single("logger", (): Logger => ({ info() {} })));
    const app = createContainer(Infra);

    expectTypeOf(app.Infra).toEqualTypeOf<{ readonly logger: () => Logger }>();
    expectTypeOf(app.start).toEqualTypeOf<() => Promise<void>>();
    expectTypeOf(app.dispose).toEqualTypeOf<() => Promise<void>>();
    expectTypeOf(app.scope).toBeFunction();
  });

  it("override .with/.withAsync infer the original entry's value type", () => {
    const Infra = createModule("Infra", (m) =>
      m
        .single("logger", (): Logger => ({ info() {} }))
        .singleAsync("config", async () => ({ env: "prod" as const })),
    );
    Infra.override((o) =>
      o
        .with("logger", (): Logger => ({ info() {} }))
        .withAsync("config", async () => ({ env: "prod" as const })),
    );
    // The provider return types above must satisfy the original entry types;
    // a wrong return type here would be a tsc error caught by typecheck:test.
    expectTypeOf(Infra.override).toBeFunction();
  });
});
```

Adjust the assertions if the exact computed type differs (e.g. the view type may
read as a `Simplify<...>` mapped type) — but every accessor-return assertion must
include a `.not.toBeAny()` companion, because catching `any`-leaks is the whole
point.

**Verify**: `bun run typecheck:test` → exit 0, no errors.

### Step 2: Prove the net actually bites

A green typecheck is only meaningful if a *wrong* assertion would fail. Prove it:

1. Temporarily change one assertion to a type you know is wrong, e.g.
   `expectTypeOf(app.Infra.logger()).toEqualTypeOf<number>();`.
2. Run `bun run typecheck:test`. It MUST now report a type error on that line.
3. Revert the change. Run `bun run typecheck:test` again → exit 0.

If step 2 does **not** error, the assertions are not being enforced (wrong file
location, or not in the `typecheck:test` program) — STOP and report.

**Verify**: the deliberately-wrong assertion fails `typecheck:test`; after revert,
it passes.

### Step 3: Confirm the full gate is green

**Verify**:
- `bun run test` → all pass, including `test/runs/types.test.ts` (the new `it`
  blocks appear and pass — runtime no-ops).
- `bun run quality` → exit 0 (lint, format, typecheck, typecheck:test with the new
  assertions, coverage-gated tests).

## Test plan

- New file `test/runs/types.test.ts` with four `it` blocks of positive
  `expectTypeOf` assertions: (1) sync/async accessor return types + `not.toBeAny`;
  (2) resolver namespaces (imported + own earlier entry) carry exact value types;
  (3) container view shape; (4) override builder return-type inference.
- Structural pattern: model module construction after
  `test/runs/module-composition.test.ts`.
- Enforcement is `bun run typecheck:test` (NOT `vitest run`). Done criteria below.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `test/runs/types.test.ts` exists with positive `expectTypeOf` assertions covering the four groups above.
- [ ] Every accessor-return assertion has a paired `.not.toBeAny()`.
- [ ] `bun run typecheck:test` exits 0.
- [ ] The Step 2 "prove it bites" check passed (a wrong assertion errors; the reverted one does not).
- [ ] `bun run test` passes, including the new file.
- [ ] `bun run quality` exits 0.
- [ ] `git status` shows only `test/runs/types.test.ts` added — nothing under `src/`.
- [ ] `plans/README.md` status row for 004 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- A positive assertion does NOT hold — e.g. `app.Infra.logger()` is `any`, or an
  accessor return type differs from the expected `() => T` / `() => Promise<T>`.
  That is a real finding about the public types; report it rather than editing
  `src/` or weakening the assertion to `toBeAny()`.
- The Step 2 proof fails (a deliberately-wrong assertion does not error under
  `typecheck:test`) — the tests are not being enforced; report the setup problem.
- The cited test files don't match the "Current state" description (drift).

## Maintenance notes

For whoever owns this next:
- These assertions are the safety net for **plan 005** (collapsing the builder
  casts). Land this first; 005 relies on it to catch any type regression the
  refactor introduces.
- Enforcement is compile-time via `typecheck:test`. If anyone switches the type
  tests to vitest's `--typecheck` mode or `*.test-d.ts` files later, ensure that
  mode is wired into the `quality` gate, or the assertions stop biting.
- When the public API gains entries/lifetimes, extend this file with matching
  positive assertions (+ `not.toBeAny()`).
