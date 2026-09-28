import { randomUUID } from "node:crypto";
import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
} from "@google/genai";
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

const REFUSALS = new Set<FinishReason | undefined>([
  FinishReason.SAFETY,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.BLOCKLIST,
  FinishReason.SPII,
  FinishReason.RECITATION,
]);

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

/**
 * Retries transient Gemini failures (429 rate limit, 5xx "high demand"), honouring the server's
 * suggested retry delay. A used-up DAILY quota isn't transient (it resets at midnight Pacific), so
 * it fails at once instead of burning time.
 */
export async function withGeminiRetry<T>(
  call: () => Promise<T>,
  onRetry: (info: { attempt: number; status: number | undefined; waitMs: number }) => void = () =>
    undefined,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const network =
        status === undefined && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
      const dailyQuota = status === 429 && /per ?day|PerDay/i.test(message);
      if (
        (!network && (status === undefined || !RETRYABLE.has(status))) ||
        dailyQuota ||
        attempt >= MAX_ATTEMPTS
      ) {
        throw error;
      }
      const suggested = /retry(?:Delay"?\s*:\s*"|\s+in\s+)([\d.]+)s/i.exec(message);
      const backoff =
        Math.min(30_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      const waitMs =
        suggested?.[1] === undefined
          ? backoff
          : Math.min(60_000, Math.ceil(Number(suggested[1]) * 1000));
      onRetry({ attempt, status, waitMs });
      await sleep(waitMs);
    }
  }
}

/** True when Gemini refused because a DAILY quota is used up (it resets at midnight Pacific). */
export function isDailyQuotaError(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 429 && /per ?day|PerDay/i.test(error.message)
  );
}

/**
 * Worth switching to the fallback model at the start of a run: the default's daily quota is gone,
 * or it stayed overloaded ("high demand") through every retry. Each model has its own capacity.
 */
export function isWorthFallingBack(error: unknown): boolean {
  return isDailyQuotaError(error) || (error instanceof ApiError && error.status === 503);
}

/**
 * Gemini via Google's `@google/genai` SDK. The model's own `Content` (including thought
 * signatures, which Gemini 3 requires on the next request) is appended to history unchanged.
 */
export class GeminiProvider implements ModelProvider {
  readonly provider = "gemini";
  private readonly ai: GoogleGenAI;
  /** The model that actually served the latest run (the fallback, if the default was out of quota). */
  private served: string;

  get model(): string {
    return this.served;
  }

  constructor(
    apiKey: string,
    private readonly defaultModel = "gemini-3.1-flash-lite",
    private readonly onRetry?: (info: {
      attempt: number;
      status: number | undefined;
      waitMs: number;
    }) => void,
    /**
     * Used for a whole run when the default model's daily quota is exhausted at its first call.
     * Each model has its own daily quota, so this roughly doubles daily capacity. Never switched
     * mid-run: a conversation (and Gemini's thought signatures) belongs to one model.
     */
    private readonly fallbackModel?: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
    this.served = defaultModel;
  }

  costMicros(usage: Usage): number {
    return costMicrosFor(PRICES[this.served], usage);
  }

  start(system: string, tools: readonly ToolSpec[], firstMessage: string): ModelSession {
    const ai = this.ai;
    let model = this.defaultModel;
    this.served = model;
    const onRetry = this.onRetry;
    const fallback = this.fallbackModel;
    const setServed = (m: string) => {
      this.served = m;
    };
    let turns = 0;
    const contents: Content[] = [{ role: "user", parts: [{ text: firstMessage }] }];
    const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    }));

    return {
      async next(): Promise<Turn> {
        const call = () =>
          withGeminiRetry(
            () =>
              ai.models.generateContent({
                model,
                contents,
                config: {
                  systemInstruction: system,
                  tools: [{ functionDeclarations }],
                  toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                  maxOutputTokens: 8192,
                },
              }),
            onRetry,
          );
        let response;
        try {
          response = await call();
        } catch (error) {
          if (turns > 0 || fallback === undefined || !isWorthFallingBack(error)) throw error;
          model = fallback;
          setServed(fallback);
          response = await call();
        }
        turns += 1;
        const candidate = response.candidates?.[0];
        const meta = response.usageMetadata;
        const usage: Usage = {
          inputTokens: meta?.promptTokenCount ?? 0,
          // Gemini bills thinking tokens as output.
          outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
          cacheReadTokens: meta?.cachedContentTokenCount ?? 0,
        };
        if (candidate?.content !== undefined) contents.push(candidate.content);

        const calls = (response.functionCalls ?? []).map((call) => ({
          id: call.id ?? randomUUID(),
          name: call.name ?? "",
          args: call.args ?? {},
        }));
        const text = (candidate?.content?.parts ?? [])
          .filter((p) => typeof p.text === "string" && p.thought !== true)
          .map((p) => p.text)
          .join("");
        const finish = candidate?.finishReason;
        const stop =
          response.promptFeedback?.blockReason !== undefined || REFUSALS.has(finish)
            ? "refused"
            : calls.length > 0
              ? "tool_calls"
              : finish === FinishReason.MAX_TOKENS
                ? "max_tokens"
                : "done";
        return { text, calls, stop, usage };
      },

      addToolResults(results: readonly ToolResult[]) {
        contents.push({
          role: "user",
          parts: results.map((r) => ({
            functionResponse: {
              id: r.call.id,
              name: r.call.name,
              response: r.isError
                ? { error: JSON.parse(r.content) as unknown }
                : { output: JSON.parse(r.content) as unknown },
            },
          })),
        });
      },
    };
  }
}
