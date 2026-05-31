import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  target: "es2022",
  platform: "neutral",
  clean: true,
  minify: false,
  treeshake: true,
  hash: false,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
