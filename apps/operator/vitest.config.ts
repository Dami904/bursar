import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["bursar-source"] },
  ssr: { resolve: { conditions: ["bursar-source"], externalConditions: ["bursar-source"] } },
});
