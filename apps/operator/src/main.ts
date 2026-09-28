/**
 * Runs the AI operator for one job.
 *
 *   OPERATOR_AGENT_KEY=bsr_agt_... pnpm --filter @bursar/operator start "the brief"
 *
 * Provider: OPERATOR_PROVIDER=gemini (default, GEMINI_API_KEY) or claude (ANTHROPIC_API_KEY).
 * Model: OPERATOR_MODEL overrides the provider's default.
 */
import { fileURLToPath } from "node:url";
import { bursarClient } from "./bursar.js";
import { runOperator } from "./operator.js";
import { providerFromEnv } from "./providers/index.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env: rely on the process environment.
}

const brief = process.argv.slice(2).join(" ").trim();
const key = process.env.OPERATOR_AGENT_KEY;
if (brief === "" || key === undefined) {
  process.stderr.write(
    'Usage: OPERATOR_AGENT_KEY=bsr_agt_... pnpm --filter @bursar/operator start "the brief"\n',
  );
  process.exit(1);
}

const result = await runOperator({
  provider: providerFromEnv(),
  bursar: bursarClient(process.env.BURSAR_API_URL ?? "http://127.0.0.1:8787", key),
  brief,
  log: (event, fields) =>
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), service: "operator", event, ...fields })}\n`,
    ),
});
process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
