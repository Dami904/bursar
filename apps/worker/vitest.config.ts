import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["bursar-source"] },
  ssr: { resolve: { conditions: ["bursar-source"], externalConditions: ["bursar-source"] } },
  test: {
    // Same test database as the API: rebuilt from migrations before the run.
    globalSetup: ["../api/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
