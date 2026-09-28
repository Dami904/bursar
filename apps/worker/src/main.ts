import { fileURLToPath } from "node:url";
import { loadWorkerEnv } from "./env.js";
import { log } from "./log.js";
import { startWorker } from "./worker.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env file: rely on the process environment (e.g. on Render).
}

const worker = await startWorker(loadWorkerEnv(process.env));
if (worker === null) process.exit(0);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    void worker.stop().then(() => process.exit(0));
  });
}
