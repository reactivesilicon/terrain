# Plan 001: Guard the examples and public API in the quality gate and CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 8df145a..HEAD -- package.json tsconfig.json tsconfig.test.json .github/workflows/ci.yml examples/`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `8df145a`, 2026-06-20

## Why this matters

The `examples/` directory is the project's showcase: `examples/public-api-usage.ts`
is what the README's quick-start is built from, and `examples/engine.ts` documents
the internal kernel surface. Neither is typechecked by any script nor run in CI —
`examples/` is excluded from both `tsconfig.json` and `tsconfig.test.json`, and the
CI workflow runs only `bun run quality` and `bun run build`. So a change to the
public API can break the showcased example (and, by extension, the documented
usage) with a fully green pipeline. Both examples typecheck and run cleanly today;
this plan adds the gate that keeps them that way.

## Current state

Files involved:

- `tsconfig.json` — source typecheck config. Excludes `examples` and `test`.
- `tsconfig.test.json` — test typecheck config. Excludes `examples`.
- `package.json` — npm scripts, including the `quality` gate.
- `.github/workflows/ci.yml` — CI; runs `bun run quality` then `bun run build`.
- `examples/public-api-usage.ts` — public-API example (imports from `../src`).
- `examples/engine.ts` — deep-import kernel example (imports `../src/container/container`, etc.).

`tsconfig.json` (note `exclude` lists `examples`):

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    // ...strict family, exactOptionalPropertyTypes, noUncheckedIndexedAccess...
    "types": []
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules", "examples", "test"]
}
```

`package.json` scripts (current — the `quality` chain is the gate run locally and in CI):

```jsonc
// package.json  (scripts section, verbatim)
"typecheck": "tsc -p tsconfig.json",
"typecheck:test": "tsc -p tsconfig.test.json",
"quality": "bun run lint && bun run format && bun run typecheck && bun run typecheck:test && bun run test:coverage",
"quality:fix": "bun run lint:fix && bun run format:fix && bun run typecheck && bun run typecheck:test && bun run test:coverage",
"prepublishOnly": "bun run quality && bun run build",
```

`.github/workflows/ci.yml` (the two run steps at the end):

```yaml
      - name: Quality gate
        run: bun run quality

      - name: Build
        run: bun run build
```

Repo conventions to match:
- Package manager is **bun** (`packageManager: bun@1.3.14`); scripts call sibling
  scripts as `bun run <name>`. Match that style.
- Typecheck scripts are `tsc -p <config>`; configs live at repo root.
- The examples use Node globals (`console`, `setTimeout`, `process`), so their
  config needs `"types": ["node"]` (the base config sets `"types": []`).
- `@types/node` is already a devDependency.

**Key gotcha (verified):** a `tsconfig.examples.json` that `extends ./tsconfig.json`
inherits `exclude: [..., "examples", ...]`. Because TypeScript's `exclude` overrides
`include`, the new config **must re-declare `exclude` without `"examples"`**, or tsc
reports `TS18003: No inputs were found`. The shape in Step 1 already does this.

## Commands you will need

| Purpose             | Command                          | Expected on success            |
|---------------------|----------------------------------|--------------------------------|
| Install             | `bun install --frozen-lockfile`  | exit 0                         |
| Typecheck src       | `bun run typecheck`              | exit 0, no errors              |
| Typecheck examples  | `bun run typecheck:examples`    | exit 0, no errors (after Step 2) |
| Full gate           | `bun run quality`               | exit 0, all pass               |
| Run public example  | `bun examples/public-api-usage.ts` | prints output, exit 0       |
| Run engine example  | `bun examples/engine.ts`        | prints output, exit 0          |

## Scope

**In scope** (the only files you should create or modify):
- `tsconfig.examples.json` (create)
- `package.json` (add one script; extend two existing scripts)
- `.github/workflows/ci.yml` (add one CI step)

**Out of scope** (do NOT touch):
- `tsconfig.json` / `tsconfig.test.json` — do not change their `include`/`exclude`;
  the examples get their own config so the source and test typechecks stay exactly
  as they are.
- Any file under `src/` or `examples/` — the examples already typecheck and run;
  this plan only adds the gate. If an example does NOT typecheck, that is a STOP
  condition (see below), not something to fix here.

## Git workflow

- Branch: `advisor/001-guard-examples` (the repo has no documented branch
  convention; this is a safe default).
- Commit message style is Conventional Commits (see `git log`: `feat: ...`,
  `release: ...`). Use e.g. `ci: typecheck and run examples in the quality gate`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `tsconfig.examples.json`

Create `tsconfig.examples.json` at the repo root with exactly this content:

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "noUnusedLocals": false,
    "noUnusedParameters": false
  },
  "include": ["src", "examples"],
  "exclude": ["dist", "node_modules", "test"]
}
```

Why each line:
- `types: ["node"]` — examples use `console`/`setTimeout`/`process`.
- `noUnusedLocals/Parameters: false` — examples intentionally show unused bindings
  (e.g. ignored callback args); mirrors how `tsconfig.test.json` relaxes these.
- `include: ["src", "examples"]` — `src` is included so the examples' imports
  resolve and are checked together; this is a harmless superset of the source
  typecheck (adding node types and relaxing unused checks cannot introduce new
  errors in `src`).
- `exclude` re-declared **without `"examples"`** — see the "Key gotcha" above.

**Verify**: `bunx tsc -p tsconfig.examples.json` → exit 0, no output (no type errors).

### Step 2: Add the `typecheck:examples` script and wire it into the gate

In `package.json`, add a new script and append it to both quality chains.

Add this script (place it next to the other typecheck scripts):

```jsonc
"typecheck:examples": "tsc -p tsconfig.examples.json",
```

Then change the `quality` and `quality:fix` scripts to run it after
`typecheck:test`. The exact replacements:

`quality` — from:
```
"quality": "bun run lint && bun run format && bun run typecheck && bun run typecheck:test && bun run test:coverage",
```
to:
```
"quality": "bun run lint && bun run format && bun run typecheck && bun run typecheck:test && bun run typecheck:examples && bun run test:coverage",
```

`quality:fix` — from:
```
"quality:fix": "bun run lint:fix && bun run format:fix && bun run typecheck && bun run typecheck:test && bun run test:coverage",
```
to:
```
"quality:fix": "bun run lint:fix && bun run format:fix && bun run typecheck && bun run typecheck:test && bun run typecheck:examples && bun run test:coverage",
```

Do not touch `prepublishOnly` — it calls `bun run quality`, so it inherits the new
check automatically.

**Verify**:
- `bun run typecheck:examples` → exit 0, no errors.
- `bun run quality` → exit 0, the whole gate passes (lint, format, both
  typechecks, examples typecheck, coverage-gated tests).

### Step 3: Run the examples as a CI step

In `.github/workflows/ci.yml`, add a step that executes both examples after the
`Build` step (running them catches runtime breakage the typecheck can't, e.g. a
disposer that throws). Keep example **execution** out of the local `quality`
script so local runs stay quiet — CI is where runtime validation belongs.

Add, as the final step of the `quality` job (after `Build`):

```yaml
      - name: Run examples
        run: |
          bun examples/public-api-usage.ts
          bun examples/engine.ts
```

Match the existing two-space step indentation in that file.

**Verify** (locally, simulating the CI step):
- `bun examples/public-api-usage.ts` → prints `user: Ada`, `use case: Found Ada`,
  `config: { env: "prod" }`, scope/fake-logger lines; exit 0.
- `bun examples/engine.ts` → prints `=== ... ===` section banners and demo lines;
  exit 0.

## Test plan

No new unit tests — this plan adds verification infrastructure, not behavior. The
"tests" are the gate commands themselves:

- `bun run typecheck:examples` exits 0.
- `bun run quality` exits 0 (now including the examples typecheck).
- Both `bun examples/*.ts` commands exit 0.

The existing 173-test suite must remain green and is run by `quality` unchanged.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `tsconfig.examples.json` exists and `bunx tsc -p tsconfig.examples.json` exits 0.
- [ ] `package.json` has a `typecheck:examples` script, and `quality` + `quality:fix` both call it.
- [ ] `bun run quality` exits 0.
- [ ] `bun examples/public-api-usage.ts` exits 0 and `bun examples/engine.ts` exits 0.
- [ ] `.github/workflows/ci.yml` has a "Run examples" step invoking both example files.
- [ ] `git status` shows only `tsconfig.examples.json` (new), `package.json`, and `.github/workflows/ci.yml` changed — nothing under `src/` or `examples/`.
- [ ] `plans/README.md` status row for 001 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- `bunx tsc -p tsconfig.examples.json` reports type errors. That means an example
  has **already drifted** from the public API. Report the errors verbatim — fixing
  the example (or the API) is a separate decision, out of scope here.
- `bun examples/public-api-usage.ts` or `bun examples/engine.ts` throws or exits
  non-zero. Report the output; do not modify the example to make it pass.
- The `quality` or `quality:fix` script in `package.json` does not match the
  "Current state" excerpt (it was edited after this plan was written) — re-read it
  and confirm where `typecheck:examples` should slot in before changing it.
- Adding the examples typecheck surfaces errors in `src/` (it should not). Report
  them rather than editing `src/`.

## Maintenance notes

For whoever owns this next:
- When the public API changes, the examples typecheck (now in `quality` and
  `prepublishOnly`) will fail until the examples are updated — that is the point.
  Keep `examples/public-api-usage.ts` aligned with the README quick-start.
- If a third example is added, it is covered automatically (the config globs
  `examples/`). If an example is meant to *demonstrate a type error*, it cannot
  live here — it would break the typecheck.
- Reviewer should confirm `quality` still passes and that no `src/`/`examples/`
  files were modified (this plan is gate-only).
- Deferred on purpose: example execution is CI-only, not in local `quality`, to
  avoid console noise on every local gate run.
