/**
 * Minimal, dependency-free test harness.
 *
 * Tests register into a module-level registry via `suite()`. `run.ts` imports
 * every *.test.ts file (registering their suites as a side effect) and then
 * calls `runAll()`. Kept tiny on purpose — no framework, runs under `tsx`.
 */

export type TestFn = () => void | Promise<void>

interface TestCase {
  name: string
  fn: TestFn
}

interface Suite {
  name: string
  tests: TestCase[]
}

const registry: Suite[] = []

/** Register a suite of tests. The body calls `test(name, fn)` to add cases. */
export function suite(name: string, body: (test: (n: string, fn: TestFn) => void) => void): void {
  const s: Suite = { name, tests: [] }
  body((n, fn) => s.tests.push({ name: n, fn }))
  registry.push(s)
}

// ── Assertions ──────────────────────────────────────────────────────────────

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AssertionError"
  }
}

export function assert(cond: unknown, message = "expected condition to be truthy"): void {
  if (!cond) throw new AssertionError(message)
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new AssertionError(message ?? `expected ${String(expected)}, got ${String(actual)}`)
  }
}

export function assertNotEqual<T>(actual: T, notExpected: T, message?: string): void {
  if (actual === notExpected) {
    throw new AssertionError(message ?? `expected value to differ from ${String(notExpected)}`)
  }
}

/** Assert that `fn` throws (sync or async) and that `pred` accepts the error. */
export async function assertThrows(
  fn: () => unknown | Promise<unknown>,
  pred: (error: unknown) => boolean,
  message = "expected function to throw",
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    if (!pred(error)) {
      throw new AssertionError(
        `threw, but predicate rejected the error: ${(error as Error)?.name ?? String(error)}`,
      )
    }
    return
  }
  throw new AssertionError(message)
}

/** Predicate factory: error is an instance of the given class. */
export function isInstance<E extends new (...args: never[]) => Error>(
  ctor: E,
): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ctor
}

// ── Helpers ───────────────────────────────────────────────────────────────

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Swallow a promise rejection so it doesn't become an unhandled rejection. */
export function ignore<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function runAll(): Promise<void> {
  let passed = 0
  let failed = 0
  const failures: { suite: string; test: string; error: unknown }[] = []

  for (const s of registry) {
    console.log(`\n${s.name}`)
    for (const tc of s.tests) {
      try {
        await tc.fn()
        passed++
        console.log(`  \u2713 ${tc.name}`)
      } catch (error) {
        failed++
        failures.push({ suite: s.name, test: tc.name, error })
        console.log(`  \u2717 ${tc.name}`)
      }
    }
  }

  console.log(`\n${"-".repeat(48)}`)
  console.log(`${passed} passed, ${failed} failed`)

  if (failures.length > 0) {
    console.log("\nFailures:")
    for (const f of failures) {
      const msg = f.error instanceof Error ? f.error.message : String(f.error)
      console.log(`  - [${f.suite}] ${f.test}\n      ${msg}`)
    }
    process.exit(1)
  }
  process.exit(0)
}