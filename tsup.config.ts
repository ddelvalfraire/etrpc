import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/main/index.ts" },
    outDir: "dist/main",
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    external: ["electron", "zod"],
  },
  {
    entry: { index: "src/renderer/index.ts" },
    outDir: "dist/renderer",
    format: ["esm"],
    dts: true,
    clean: true,
    external: ["electron", "zod"],
  },
  {
    entry: { index: "src/preload/index.ts" },
    outDir: "dist/preload",
    format: ["cjs"],
    dts: true,
    clean: true,
    external: ["electron"],
  },
  {
    entry: { index: "src/react/index.ts" },
    outDir: "dist/react",
    format: ["esm"],
    dts: true,
    clean: true,
    external: ["react", "zod"],
  },
]);
