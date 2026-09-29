import { defineConfig } from "vitest/config";

// Read workspace packages (@bursar/money) from source, as everywhere else. Without this the tests
// only passed where a stale dist/ build happened to exist.
export default defineConfig({
  resolve: { conditions: ["bursar-source"] },
  ssr: { resolve: { conditions: ["bursar-source"], externalConditions: ["bursar-source"] } },
});
