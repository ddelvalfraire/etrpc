import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/types/**"],
  },
  resolve: {
    alias: {
      "#src": path.resolve(__dirname, "src"),
      "#test": path.resolve(__dirname, "tests"),
    },
  },
});
