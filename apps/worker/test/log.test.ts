import { afterEach, describe, expect, it, vi } from "vitest";
import { errorText, log, redact } from "../src/log.js";

const RPC = "https://rpc.example.com/v1/secret-access-token-0123456789";

describe("log redaction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("never writes the RPC URL (and its token) into a log line or a stored error", () => {
    vi.stubEnv("ARC_RPC_URL", RPC);
    const error = new Error(`HTTP request failed.\n\nURL: ${RPC}\nRequest body: {}`);
    expect(redact(`URL: ${RPC}`)).toBe("URL: <arc-rpc-url>");
    expect(errorText(error)).not.toContain("secret-access-token");
    expect(errorText(error)).toContain("<arc-rpc-url>");

    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    log.error("release failed", error, { note: RPC });
    expect(writes.join("")).not.toContain("secret-access-token");
  });

  it("clips stored errors", () => {
    expect(errorText(new Error("x".repeat(900)))).toHaveLength(500);
    expect(errorText("plain", 3)).toBe("pla");
  });
});
