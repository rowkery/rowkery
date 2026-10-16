import { defineConfig } from "vitest/config";

// Unit tests for the pure TypeScript modules (no DOM, no Tauri). `npm test`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
