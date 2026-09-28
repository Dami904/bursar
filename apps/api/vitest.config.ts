import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["bursar-source"] },
  ssr: { resolve: { conditions: ["bursar-source"], externalConditions: ["bursar-source"] } },
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Test files share one database; run them one at a time. Concurrency is tested inside files.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
