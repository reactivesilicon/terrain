# Plan 002: Fix STATUS.md `bench/` drift and decide `skills-lock.json` tracking

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 8df145a..HEAD -- STATUS.md .gitignore`
> If either file changed since this plan was written, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `8df145a`, 2026-06-20

## Why this matters

`STATUS.md` is the authoritative maintainer doc, but it references a benchmark
script — `bench/module-composition-type-bench.mjs` — that does not exist in the
repository (it only ever lived in a `leap-q1` git stash, never committed; there is
no `bench/` directory and `git ls-files` lists no bench files). It is cited twice,
once as a runnable command in the "Verification quickstart". A canonical status doc
that lists a command which errors out erodes trust in the rest of the doc. Separately,
`skills-lock.json` is currently untracked and **not** gitignored, so the next
`git add -A` will sweep it into a commit with no decision recorded about whether it
belongs in version control. This plan removes the dead references and makes the
`skills-lock.json` decision explicit.

## Current state

Files involved:

- `STATUS.md` — maintainer status notes. Two stale `bench/` references.
- `.gitignore` — already ignores `/.agents/` and `/.claude/` (the directories where
  skills are installed). Does not mention `skills-lock.json`.
- `skills-lock.json` — untracked lockfile recording installed skills (its `source`
  points at `shadcn/improve`). It is the lockfile for skills that live under the
  already-ignored `/.agents/` and `/.claude/` directories.

`STATUS.md`, "Engineering infrastructure" section (the dead bullet is the
`Benchmark:` line):

```markdown
## Engineering infrastructure

- Test runner: Vitest via `bun run test`; `bun test` is not the configured runner.
- Full gate: `bun run quality` = oxlint + oxfmt + source typecheck + test typecheck + coverage-gated Vitest.
- Build: `bun run build` via `tsdown`.
- Fuzzers print `TEST_SEED` for replay:
  - `test/runs/stress.test.ts`
  - `test/runs/stress-module-composition.test.ts`
- Benchmark: `bench/module-composition-type-bench.mjs`.
- Coverage gates in `quality`: statements 99, branches 97, functions 99, lines 100.
```

`STATUS.md`, "Verification quickstart" section (the dead line is `node bench/...`):

````markdown
## Verification quickstart

```sh
bun run quality
bun run build
bun examples/public-api-usage.ts
TEST_SEED=<n> bun run test
node bench/module-composition-type-bench.mjs
```
````

`.gitignore` (last lines, verbatim — note the file ends at `/.claude/`):

```
.vscode/*
.idea
.idea/*
/.idea/

/dist
/.agents/
/.claude/
```

## Commands you will need

| Purpose                  | Command                             | Expected on success                    |
| ------------------------ | ----------------------------------- | -------------------------------------- | ---------------------------- |
| Confirm no bench in repo | `git ls-files                       | grep -i bench`                         | no output (exit 1 from grep) |
| Confirm bench refs gone  | `grep -rn "bench" STATUS.md`        | no output after Step 1                 |
| Confirm ignore works     | `git check-ignore skills-lock.json` | prints `skills-lock.json` after Step 2 |

## Scope

**In scope** (the only files you should modify):

- `STATUS.md`
- `.gitignore`

**Out of scope** (do NOT touch):

- Do NOT create a `bench/` directory or write a benchmark script. The script is
  gone and recreating a type-level benchmark requires maintainer intent; this plan
  only removes the dangling references.
- Do NOT rewrite the rest of `STATUS.md`. In particular, the "Where things stand"
  section still describes `main` as holding v1.0.0 with `leap-q1` as the
  uncommitted release candidate, which is now out of date (the composition API has
  been merged to `main`). Correcting that narrative needs maintainer knowledge of
  branch/release intent — leave it alone and note it (see STOP conditions).
- Do NOT delete or move `skills-lock.json` itself; only adjust `.gitignore`.

## Git workflow

- Branch: `advisor/002-status-housekeeping`.
- Commit message style is Conventional Commits. Use e.g.
  `docs: drop dead bench references from STATUS.md and ignore skills-lock.json`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Remove the two dead `bench/` references in `STATUS.md`

1. In the "Engineering infrastructure" list, delete the entire bullet line:

   ```
   - Benchmark: `bench/module-composition-type-bench.mjs`.
   ```

   Leave the surrounding bullets (Fuzzers, Coverage gates) intact.

2. In the "Verification quickstart" `sh` code block, delete the line:
   ```
   node bench/module-composition-type-bench.mjs
   ```
   Leave the other four commands in the block intact.

**Verify**: `grep -rn "bench" STATUS.md` → no output (exit code 1).

### Step 2: Ignore `skills-lock.json`

`skills-lock.json` is the lockfile for skills installed under `/.agents/` and
`/.claude/`, both already gitignored. Committing a lockfile for ignored content is
inconsistent, so the default decision is to ignore it too.

Append a new line to `.gitignore` after the `/.claude/` line:

```
/.claude/
/skills-lock.json
```

(Add `/skills-lock.json` as a new final line; ensure the file ends with a newline.)

**Verify**:

- `git check-ignore skills-lock.json` → prints `skills-lock.json`.
- `git status --short` → no longer lists `skills-lock.json` as untracked.

## Test plan

No code, so no unit tests. Verification is the two `grep`/`git check-ignore`
commands in the steps above plus the Done criteria below.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "bench" STATUS.md` returns no matches.
- [ ] `git check-ignore skills-lock.json` prints `skills-lock.json`.
- [ ] `git status --short` does not list `skills-lock.json`.
- [ ] `git status` shows only `STATUS.md` and `.gitignore` modified.
- [ ] `plans/README.md` status row for 002 updated to DONE.

## STOP conditions

Stop and report back (do not improvise) if:

- `git ls-files | grep -i bench` returns any tracked file, or a `bench/` directory
  exists — the premise (no bench in the repo) is wrong; report what you found.
- The `STATUS.md` "Engineering infrastructure" / "Verification quickstart"
  sections do not match the "Current state" excerpts — the doc was edited after
  this plan was written.
- You find `skills-lock.json` is referenced or required by tracked tooling (search:
  `grep -rn "skills-lock" --exclude-dir=node_modules .`). If something tracked
  reads it, ignoring it may be wrong — report instead, since the alternative
  decision (commit it) would then be preferable.

## Maintenance notes

For whoever owns this next:

- **`skills-lock.json` decision is reversible.** The default here is to ignore it
  (consistent with the ignored skill directories). If the team instead wants
  reproducible skill installs across machines, commit `skills-lock.json` and remove
  the `.gitignore` line — but then consider whether the `/.agents/` and `/.claude/`
  ignores should change too.
- The broader `STATUS.md` staleness (the "Where things stand" section still
  framing `main` as v1.0.0 and `leap-q1` as the unmerged candidate) is left for a
  maintainer pass — it needs knowledge of the intended branch/release story that an
  executor cannot infer.
- If a real benchmark is reintroduced later, restore both `STATUS.md` references
  alongside the committed script.
