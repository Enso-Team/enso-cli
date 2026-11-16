import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@enso-app/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)) }
  },
  test: {
    include: ["test/**/*.test.ts", "packages/core/test/**/*.test.ts"]
  }
});
