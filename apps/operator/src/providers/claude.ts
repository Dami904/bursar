import Anthropic from "@anthropic-ai/sdk";
import {
  PRICES,
  costMicrosFor,
  type ModelProvider,
  type ModelSession,
  type ToolResult,
  type ToolSpec,
  type Turn,
  type Usage,
} from "../model.js";

/**
 * Claude via the official Anthropic SDK. Adaptive thinking (the default on Claude Opus 5) with
 * `high` effort, since these are money decisions; the full response content is appended to
 * history so thinking blocks round-trip unchanged. Server-side refusal fallbacks are on, so a
 * declined request is retried on a fallback model inside the same call.
 */
export class ClaudeProvider implements ModelProvider {
  readonly provider = "claude";
  private readonly client: Anthropic;

  constructor(
    apiKey: string | undefined,
    readonly model = "claude-opus-5",
  ) {
    this.client = apiKey === undefined ? new Anthropic() : new Anthropic({ apiKey });
  }

  costMicros(usage: Usage): number {
    return costMicrosFor(PRICES[this.model], usage);
  }

  start(system: string, tools: readonly ToolSpec[], firstMessage: string): ModelSession {
    const client = this.client;
    const model = this.model;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: firstMessage }];
    const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      strict: true,
      input_schema: t.parameters as unknown as Anthropic.Beta.BetaTool.InputSchema,
    }));

    return {
      async next(): Promise<Turn> {
        const response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          system,
          tools: toolDefs,
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: "high" },
          // The stable system prompt and tool list are cached across turns.
          cache_control: { type: "ephemeral" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        } as Anthropic.Beta.MessageCreateParamsNonStreaming);
        messages.push({ role: "assistant", content: response.content });

        const calls = response.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            name: b.name,
            args: (b.input ?? {}) as Record<string, unknown>,
          }));
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const usage: Usage = {
          inputTokens:
            response.usage.input_tokens +
            (response.usage.cache_read_input_tokens ?? 0) +
            (response.usage.cache_creation_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        };
        const stop =
          response.stop_reason === "refusal"
            ? "refused"
            : calls.length > 0
              ? "tool_calls"
              : response.stop_reason === "max_tokens"
                ? "max_tokens"
                : "done";
        return { text, calls, stop, usage };
      },

      addToolResults(results: readonly ToolResult[]) {
        // All results for one turn go in a single user message.
        messages.push({
          role: "user",
          content: results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.call.id,
            content: r.content,
            is_error: r.isError,
          })),
        });
      },
    };
  }
}
