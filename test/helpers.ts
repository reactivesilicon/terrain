export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Swallow a promise rejection so it doesn't become an unhandled rejection. */
export function ignore<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

// Deterministic pseudo-random [0, 1) sequence (linear congruential generator,
// Numerical Recipes constants). Seeded from TEST_SEED — set by the vitest
// global setup — so a failing randomized run is reproducible.
let randomState = Number(process.env.TEST_SEED ?? 1) >>> 0;

export function random(): number {
  const MULTIPLIER = 1664525;
  const INCREMENT = 1013904223;
  randomState = (Math.imul(randomState, MULTIPLIER) + INCREMENT) >>> 0;
  return randomState / 2 ** 32;
}
