import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../src/providers/gemini.js";

const dailyQuota = () =>
  new ApiError({
    status: 429,
    message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 500, per day",
  });

const reply = { candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }] };

/** A provider whose SDK calls are answered by `answer(model, callNumber)`. */
function fakeProvider(answer: (model: string, n: number) => unknown, fallback?: string) {
  const provider = new GeminiProvider("test-key", "gemini-3.1-flash-lite", undefined, fallback);
  const models: string[] = [];
  (provider as unknown as { ai: unknown }).ai = {
    models: {
      generateContent: async ({ model }: { model: string }) => {
        models.push(model);
        const result = answer(model, models.length);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { provider, models };
}

describe("GeminiProvider fallback model", () => {
  it("also falls back when the default stays overloaded at the start of a run", async () => {
    const overloaded = () => new ApiError({ status: 503, message: "high demand" });
    const { provider, models } = fakeProvider(
      (model) => (model === "gemini-3.1-flash-lite" ? overloaded() : reply),
      "gemini-3.5-flash-lite",
    );
    await provider.start("system", [], "hi").next();
    expect(models.at(-1)).toBe("gemini-3.5-flash-lite");
  }, 60_000);

  it("runs the whole session on the fallback when the default's daily quota is gone at the start", async () => {
    const { provider, models } = fakeProvider(
      (model) => (model === "gemini-3.1-flash-lite" ? dailyQuota() : reply),
      "gemini-3.5-flash-lite",
    );
    const session = provider.start("system", [], "hi");
    await session.next();
    await session.next();
    expect(models).toEqual([
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash-lite",
    ]);
    expect(provider.model).toBe("gemini-3.5-flash-lite");
    // Cost is priced at the fallback's rates.
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
    expect(provider.costMicros(usage)).toBe(300_000);
  });

  it("never switches mid-run: the conversation belongs to one model", async () => {
    const { provider, models } = fakeProvider(
      (_model, n) => (n === 1 ? reply : dailyQuota()),
      "gemini-3.5-flash-lite",
    );
    const session = provider.start("system", [], "hi");
    await session.next();
    await expect(session.next()).rejects.toThrow(/per day/);
    expect(models).toEqual(["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"]);
  });

  it("starts each new run on the default again", async () => {
    let quotaGone = true;
    const { provider, models } = fakeProvider(
      (model) => (quotaGone && model === "gemini-3.1-flash-lite" ? dailyQuota() : reply),
      "gemini-3.5-flash-lite",
    );
    await provider.start("system", [], "hi").next();
    quotaGone = false;
    await provider.start("system", [], "hi").next();
    expect(models.at(-1)).toBe("gemini-3.1-flash-lite");
    expect(provider.model).toBe("gemini-3.1-flash-lite");
  });

  it("without a fallback, a used-up daily quota fails the run", async () => {
    const { provider } = fakeProvider(() => dailyQuota());
    await expect(provider.start("system", [], "hi").next()).rejects.toThrow(/per day/);
  });
});
