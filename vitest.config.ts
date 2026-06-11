import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: "./test/global-setup.ts",
    coverage: {
      include: ["src/**"],
      reporter: ["text"],
      thresholds: {
        statements: 99,
        branches: 97,
        functions: 99,
        lines: 100,
      },
    },
  },
});
