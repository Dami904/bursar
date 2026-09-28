import { describe, expect, it } from "vitest";
import {
  authorizationStates,
  bucketOf,
  isLegalTransition,
  isTerminal,
  transitionDelta,
  type AuthorizationState,
} from "../src/index.js";

describe("transitionDelta", () => {
  it("moves approval-pending money into reserved when approved", () => {
    expect(transitionDelta("PENDING_APPROVAL", "RESERVED", 5n)).toEqual({
      pending: -5n,
      reserved: 5n,
      unresolved: 0n,
      settled: 0n,
    });
  });

  it("frees pending money when rejected", () => {
    expect(transitionDelta("PENDING_APPROVAL", "REJECTED", 5n)).toEqual({
      pending: -5n,
      reserved: 0n,
      unresolved: 0n,
      settled: 0n,
    });
  });

  it("keeps money reserved through the on-chain steps", () => {
    for (const [from, to] of [
      ["RESERVED", "RELEASING"],
      ["RELEASING", "FUNDED_WALLET"],
      ["FUNDED_WALLET", "SIGNING"],
    ] as const) {
      expect(transitionDelta(from, to, 5n)).toEqual({
        pending: 0n,
        reserved: 0n,
        unresolved: 0n,
        settled: 0n,
      });
    }
  });

  it("never frees money on an uncertain outcome", () => {
    const delta = transitionDelta("SIGNING", "UNRESOLVED", 5n);
    expect(delta.reserved + delta.unresolved).toBe(0n);
    expect(delta.unresolved).toBe(5n);
  });

  it("settles unresolved money found on-chain", () => {
    expect(transitionDelta("UNRESOLVED", "SETTLED", 5n)).toEqual({
      pending: 0n,
      reserved: 0n,
      unresolved: -5n,
      settled: 5n,
    });
  });

  it("rejects illegal transitions", () => {
    expect(() => transitionDelta("SETTLED", "RELEASED", 5n)).toThrow(RangeError);
    expect(() => transitionDelta("UNRESOLVED", "RESERVED", 5n)).toThrow(RangeError);
    expect(() => transitionDelta("PENDING_APPROVAL", "SETTLED", 5n)).toThrow(RangeError);
  });
});

describe("state table", () => {
  it("only lets money leave the budget through RELEASED or REJECTED", () => {
    for (const from of authorizationStates) {
      for (const to of authorizationStates) {
        if (!isLegalTransition(from, to)) continue;
        const delta = transitionDelta(from, to, 7n);
        const net = delta.pending + delta.reserved + delta.unresolved + delta.settled;
        const freed = to === "RELEASED" || to === "REJECTED";
        expect(net, `${from} -> ${to}`).toBe(freed ? -7n : 0n);
      }
    }
  });

  it("marks exactly the settled, released and rejected states terminal", () => {
    const terminal = authorizationStates.filter((s) => isTerminal(s));
    expect(terminal.sort()).toEqual(["REJECTED", "RELEASED", "SETTLED"]);
  });

  it("gives every non-terminal state a budget bucket", () => {
    const counted: AuthorizationState[] = authorizationStates.filter((s) => !isTerminal(s));
    for (const state of counted) {
      expect(bucketOf[state], state).not.toBeNull();
    }
  });
});
