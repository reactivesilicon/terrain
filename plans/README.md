# Implementation plans

Prepared by the improve skill on 2026-09-05 against commit `801c2b0`. The user selected all eight audit findings. These are implementation handoffs; no source fixes, commits, builds, releases, or issue publication were performed by the advisor. Status is maintained in this index, not duplicated in individual plans.

Read each plan completely before execution. Every plan includes its own context, source excerpts, scope, tests, verification gates, and STOP conditions. Run the drift check in the actual executor checkout. Do not copy a plan into execution without reconciling prerequisite changes to its excerpts.

## Execution order and status

| Plan                                             | Finding and intended outcome                                                               | Priority | Effort | Risk | Depends on      | Status |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------- | ------ | ---- | --------------- | ------ |
| [001](001-coordinate-callback-scope-cleanup.md)  | Coordinate ordinary callback-scope cleanup while preserving explicit lifecycle exclusivity | P1       | M      | MED  | —               | TODO   |
| [002](002-atomic-async-resolution-commit.md)     | Make cached async publication and disposal registration atomic with lifecycle validation   | P1       | M      | MED  | 001, sequencing | TODO   |
| [003](003-preserve-prototype-named-accessors.md) | Preserve `__proto__` entries through intermediate accessor dictionaries                    | P2       | S      | LOW  | —               | TODO   |
| [004](004-preserve-conditional-module-types.md)  | Represent alternative/possibly absent modules soundly in public types                      | P2       | M      | MED  | —               | TODO   |
| [005](005-correlate-override-keys-and-values.md) | Reject ambiguous union override keys while preserving narrowed-key inference               | P2       | M      | MED  | 004, sequencing | TODO   |
| [006](006-verify-distributed-package.md)         | Exercise packed exports, bundled declarations, and the minimum consumer runtime            | P2       | M      | LOW  | —               | TODO   |
| [007](007-document-factory-ownership.md)         | Explain caller-owned factory instances and orphan-only factory cleanup callbacks           | P2       | S      | LOW  | —               | TODO   |
| [008](008-qualify-override-cycle-guarantees.md)  | Qualify structural acyclicity claims and pin typed override cycles in tests                | P3       | S      | LOW  | 007, sequencing | TODO   |

Effort includes tests: S = hours; M = roughly a day. Plan 001 has a design risk around reentrant disposal and may require a bounded follow-up decision if the existing runtime cannot distinguish safe waiting. Do not treat that estimate as authorization to weaken exclusivity.

Status values: TODO, IN PROGRESS, DONE, BLOCKED (include a reason), REJECTED (include a rationale). An executor records a compact verification result with its status; a reviewer may maintain the row instead. Do not mark an unrun required compatibility check as passed.

## Dependencies and shared files

Recommended execution is 001 through 008. The defects are mostly independent; the listed sequencing dependencies avoid overlapping changes and force reconciliation:

- 001 → 002: both touch lifecycle code in `src/container/container.ts`. If 001 stops for a design decision, 002 can proceed independently only after a reviewer explicitly records that revised order and checks for unfinished edits.
- 004 → 005: both change `src/module-composition/types.ts` and `test/runs/types.test.ts`. Plan 005 must retain the conditional-namespace assertions added by 004.
- 007 → 008: both edit README and TECHNICAL.md; 008 must preserve factory ownership qualifications.
- 006 has no implementation dependency, but its full artifact checks should run again after the selected source changes are integrated. Build on the development runtime; execute the same packed artifact on minimum Node separately.
- 001, 002, 003, 004, and 008 share `test/runs/module-composition.test.ts`. Do not assign simultaneous edits to that file in one checkout. Isolated worktrees still require careful test merge review.

No plan authorizes changes to another plan's behavior. Regression tests for each fix are part of that plan, not a separate prerequisite that can be omitted. New tests intentionally fail at the documented red phase; existing passing tests must not be weakened.

## Confidence and intent decisions

- **001:** reproduced contract conflict. Explicit lifecycle rejection is intentional and tested; ordinary callback scopes also promise automatic cleanup. The plan preserves explicit rejection and makes reentrancy a specific STOP condition rather than prescribing an unconditional queue.
- **002 and 003:** reproduced implementation defects against explicit documented intent: teardown-race safety and all-identifier name safety.
- **004 and 005:** reproduced TypeScript unsoundness with runtime consequences; no intentional exception was found in the reviewed docs, tests, or relevant history. Their repair policy is explicit: preserve conditional alternatives for namespaces; conservatively require narrowed keys for overrides. Tightening accepted types must be called out in release review.
- **006:** a verified coverage gap, not a claim that the current published artifact is broken.
- **007 and 008:** documentation mismatches. Caller ownership of successful factory instances and runtime detection of override-created cycles remain intact.

Behavioral evidence was independently reproduced through public APIs. Type reproducers were checked with an in-memory strict TypeScript program, including an invalid literal-key control that correctly failed. Confidence in those observations is high; undocumented maintainer intent cannot be established with absolute certainty.

## Verification baseline and scope of the audit

At `801c2b0`, the advisor ran:

- `bun run test`: 199 passed, one deliberately skipped opt-in measurement; 18 files passed and one skipped.
- `bun run typecheck:all`: source, test, and example typechecks passed.
- `bun run lint`: exit 0, seven pre-existing warnings.
- `bun run format`: passed before plan creation.
- `bun audit`: reported development-tool advisories. A reachable affected runtime/build path was not established, so dependency changes were not prioritized.

The installed advisor Bun was 1.3.8; the repository pins 1.3.14. No install or dependency changes were performed. Coverage-gated quality, a new build, packed-artifact tests, minimum-runtime compatibility, and performance benchmarking were not run by the advisor. Each plan gives the executor the applicable complete release gates; plan 006 adds the missing consumer boundary.

This was a standard audit across correctness, security, performance, tests, architecture, dependencies, tooling, docs, and direction, weighted toward the public composition layer and lifecycle engine. It was not an exhaustive third-party dependency/source audit or a platform compatibility matrix.

## Findings considered and rejected

- **Remove the lifecycle lock:** rejected; tree-wide exclusivity and explicit conflict errors are intentional. Plan 001 addresses their interaction with callback cleanup.
- **Automatically track every successful factory:** rejected; tests explicitly establish caller ownership. Plan 007 corrects the public explanation.
- **Treat conservative async cycle detection as false-positive behavior to remove:** rejected; every provider `getAsync` is intentionally a dependency acquisition, even if ignored or raced.
- **Ban override access to other/later entries to make acyclicity universal:** rejected; this is an existing supported capability. Plan 008 qualifies documentation instead.
- **Missing runtime hot-swap, decorators, optional resolution, multibinding, or public type renaming:** documented non-goals/deferred work, not implementation defects.
- **Skipped performance measurement as lost correctness coverage:** rejected; the measurement is intentionally opt-in.
- **Timer-based tests as proven flakiness:** not established; no observed flaky failure. New race regressions use controlled promises.
- **Development dependency advisories as demonstrated production vulnerabilities:** reachability was not established; do not report a confirmed exploit or update dependencies under these plans.
- **Missing changelog:** GitHub Releases is the deliberately chosen changelog channel.
- **Generic internal cleanup or cast elimination:** intentional type-erasure seams and naming preferences are not a reason to expand these eight changes.

## Direction options not selected

The audit also identified a practical request-context integration recipe and larger runtime/typechecking measurements as optional future work. They were not among the eight selected findings and have no implementation plan in this batch.
