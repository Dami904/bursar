import { ApiError } from "@google/genai";
import { describe, expect, it } from "vitest";
import { withGeminiRetry } from "../src/providers/gemini.js";

const apiError = (status: number, message: string) => new ApiError({ status, message });

function flaky(failures: Error[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    call: async () => {
      calls += 1;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      return "ok";
    },
  };
}

const noSleep = async () => undefined;

describe("withGeminiRetry", () => {
  it("retries 'high demand' 503s and 500s until the call succeeds", async () => {
    const f = flaky([
      apiError(503, "This model is currently experiencing high demand."),
      apiError(500, "Internal error"),
    ]);
    const waits: number[] = [];
    await expect(withGeminiRetry(f.call, (i) => waits.push(i.waitMs), noSleep)).resolves.toBe("ok");
    expect(f.calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("waits as long as a 429 says to", async () => {
    const f = flaky([apiError(429, '{"error":{"code":429,"details":[{"retryDelay":"37s"}]}}')]);
    const waits: number[] = [];
    await withGeminiRetry(f.call, (i) => waits.push(i.waitMs), noSleep);
    expect(waits).toEqual([37_000]);
  });

  it("doesn't retry a used-up daily quota: it won't recover until midnight Pacific", async () => {
    const f = flaky([
      apiError(
        429,
        "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, per day",
      ),
    ]);
    await expect(withGeminiRetry(f.call, undefined, noSleep)).rejects.toThrow(/per day/);
    expect(f.calls).toBe(1);
  });

  it("doesn't retry a bad request or a missing model", async () => {
    const bad = flaky([apiError(400, "Invalid argument")]);
    await expect(withGeminiRetry(bad.call, undefined, noSleep)).rejects.toThrow();
    expect(bad.calls).toBe(1);
    const gone = flaky([apiError(404, "no longer available to new users")]);
    await expect(withGeminiRetry(gone.call, undefined, noSleep)).rejects.toThrow();
    expect(gone.calls).toBe(1);
  });

  it("gives up after five attempts", async () => {
    const f = flaky(Array.from({ length: 10 }, () => apiError(503, "high demand")));
    await expect(withGeminiRetry(f.call, undefined, noSleep)).rejects.toThrow();
    expect(f.calls).toBe(5);
  });
});
