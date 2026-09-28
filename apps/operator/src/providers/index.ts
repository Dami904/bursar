import type { ModelProvider } from "../model.js";
import { ClaudeProvider } from "./claude.js";
import { GeminiProvider } from "./gemini.js";

/**
 * Picks the model from the environment. OPERATOR_PROVIDER=gemini (default, GEMINI_API_KEY) or
 * claude (ANTHROPIC_API_KEY); OPERATOR_MODEL overrides the default model.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const which = env.OPERATOR_PROVIDER ?? "gemini";
  const model = env.OPERATOR_MODEL || undefined;
  if (which === "claude") {
    return new ClaudeProvider(env.ANTHROPIC_API_KEY || undefined, model ?? "claude-opus-5");
  }
  const apiKey = env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey === "") throw new Error("GEMINI_API_KEY is not set");
  // Default and fallback chosen by docs/evals/operator-models.md: 3.1 Flash-Lite is as accurate as
  // 3.5 Flash-Lite and ~6x faster; each has its own 500-requests/day free-tier quota.
  return new GeminiProvider(
    apiKey,
    model ?? "gemini-3.1-flash-lite",
    undefined,
    env.OPERATOR_FALLBACK_MODEL ?? "gemini-3.5-flash-lite",
  );
}

/** Whether the environment has what providerFromEnv needs. */
export function hasModelKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPERATOR_PROVIDER ?? "gemini") === "claude"
    ? Boolean(env.ANTHROPIC_API_KEY)
    : Boolean(env.GEMINI_API_KEY);
}
