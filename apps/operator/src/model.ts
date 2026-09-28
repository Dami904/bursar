/**
 * The operator talks to any model through this interface. Each provider keeps its own native
 * conversation history (Claude's content blocks, Gemini's parts with thought signatures), so the
 * operator loop never has to translate or reconstruct it.
 */

/** A tool the model may call. `parameters` is a JSON Schema object (strict: no extra fields). */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

export type StopKind =
  /** The model wants tools run. */
  | "tool_calls"
  /** The model finished without calling a tool. */
  | "done"
  /** A safety system declined the request. */
  | "refused"
  /** The response was cut off by the output limit. */
  | "max_tokens";

export interface Turn {
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly stop: StopKind;
  readonly usage: Usage;
}

export interface ToolResult {
  readonly call: ToolCall;
  /** JSON text returned to the model. */
  readonly content: string;
  readonly isError: boolean;
}

export interface ModelSession {
  /** Asks the model for its next turn, given everything so far. */
  next(): Promise<Turn>;
  /** Appends the results of the tool calls from the last turn. */
  addToolResults(results: readonly ToolResult[]): void;
}

export interface ModelProvider {
  /** e.g. "gemini" or "claude". */
  readonly provider: string;
  readonly model: string;
  start(system: string, tools: readonly ToolSpec[], firstMessage: string): ModelSession;
  /** Cost of the given usage in micro-USD. */
  costMicros(usage: Usage): number;
}

export interface Pricing {
  /** USD per million tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/**
 * Published per-million-token prices (paid tier). Checked 2026-09-28:
 * Gemini on ai.google.dev/gemini-api/docs/pricing, Claude from Anthropic's model table.
 */
export const PRICES: Record<string, Pricing> = {
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cacheRead: 0.05 },
  // Promotional input price through 2026-12-31 ($1.50 after).
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
  "gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
};

export function costMicrosFor(pricing: Pricing | undefined, usage: Usage): number {
  if (pricing === undefined) return 0;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  // tokens × $/1M = micro-USD per token × tokens
  return Math.round(
    uncachedInput * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead,
  );
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
