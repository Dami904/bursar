/**
 * Live check of the Gemini provider before the operator relies on it: one tool, a full
 * call -> result -> answer round trip, usage and cost. Costs a fraction of a cent (free tier: 0).
 *
 *   pnpm --filter @bursar/operator smoke:gemini
 */
import { fileURLToPath } from "node:url";
import { GeminiProvider } from "../src/providers/gemini.js";

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const provider = new GeminiProvider(
  process.env.GEMINI_API_KEY ?? "",
  process.env.OPERATOR_MODEL ?? "gemini-3.1-flash-lite",
);

const session = provider.start(
  "You are a careful assistant. Use the tool to answer.",
  [
    {
      name: "get_price",
      description: "The price in USDC of a named item.",
      parameters: {
        type: "object",
        properties: { item: { type: "string" } },
        required: ["item"],
        additionalProperties: false,
      },
    },
  ],
  "What does the 'insight' item cost? Answer in one short sentence.",
);

const first = await session.next();
console.log("turn 1:", { stop: first.stop, calls: first.calls, usage: first.usage });
const call = first.calls[0];
if (call === undefined) throw new Error("Gemini didn't call the tool");
if (call.name !== "get_price") throw new Error(`Unexpected tool ${call.name}`);

session.addToolResults([
  { call, content: JSON.stringify({ item: call.args.item, price: "0.01 USDC" }), isError: false },
]);
const second = await session.next();
console.log("turn 2:", { stop: second.stop, text: second.text, usage: second.usage });
if (second.stop !== "done" || !second.text.includes("0.01"))
  throw new Error("Round trip didn't produce the answer");

const total = {
  inputTokens: first.usage.inputTokens + second.usage.inputTokens,
  outputTokens: first.usage.outputTokens + second.usage.outputTokens,
  cacheReadTokens: 0,
};
console.log(
  `OK: ${provider.model} round trip works. Cost at paid-tier prices: $${(provider.costMicros(total) / 1e6).toFixed(6)}`,
);
