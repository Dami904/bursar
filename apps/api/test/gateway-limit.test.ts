import { describe, expect, it } from "vitest";
import { gatewayAboveApproval } from "../src/services/gateway-limit.js";

describe("Gateway payments above the job's approval amount", () => {
  it("are refused up front, naming both amounts", () => {
    const message = gatewayAboveApproval("GATEWAY", 54_501n, 50_000n);
    expect(message).toContain("0.05");
    expect(message).toContain("0.054501");
    expect(message).toContain("Ask me above");
  });

  it("pass at or under the amount, and on other rails whatever the price", () => {
    expect(gatewayAboveApproval("GATEWAY", 50_000n, 50_000n)).toBeNull();
    expect(gatewayAboveApproval("GATEWAY", 1_000n, 50_000n)).toBeNull();
    expect(gatewayAboveApproval("VAULT", 900_000n, 50_000n)).toBeNull();
  });
});
