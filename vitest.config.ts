import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@intelligence/core": path.resolve("packages/core/src/index.ts"),
      "@intelligence/database": path.resolve("packages/database/src/index.ts"),
      "@intelligence/providers": path.resolve("packages/providers/src/index.ts"),
      "@intelligence/config": path.resolve("packages/config/src/index.ts"),
      "@intelligence/shared": path.resolve("packages/shared/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] }
  }
});
