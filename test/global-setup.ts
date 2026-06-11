// Pins one seed for the whole run (workers inherit it via the environment) so
// randomized tests are reproducible: re-run with TEST_SEED=<printed value>.
export default function globalSetup(): void {
  process.env.TEST_SEED ??= String(Math.floor(Math.random() * 2 ** 31));
  console.log(`seed: ${process.env.TEST_SEED} (re-run with TEST_SEED=${process.env.TEST_SEED} to reproduce)`);
}
