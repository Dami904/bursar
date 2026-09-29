import { fileURLToPath } from "node:url";
import { loadWorkerEnv } from "./env.js";
import { log } from "./log.js";
import { startWorker, type RunningWorker } from "./worker.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env file: rely on the process environment (e.g. on Render).
}

const env = loadWorkerEnv(process.env);
let worker: RunningWorker | null = null;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("shutting down", { signal });
    stopping = true;
    void (worker?.stop() ?? Promise.resolve()).then(() => process.exit(0));
  });
}

// During a deploy the old instance still holds the worker lock for a while. Wait for it rather
// than exiting: the API may share this process and must keep serving.
const RETRY_MS = 15_000;
while (!stopping) {
  worker = await startWorker(env);
  if (worker !== null) break;
  await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
}
