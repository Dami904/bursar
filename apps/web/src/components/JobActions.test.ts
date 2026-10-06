import { describe, expect, it } from "vitest";
import type { Job } from "../lib/api.js";
import { followIndexer } from "./JobActions.js";

/** A query client whose job reads as `statuses` in turn, one per refetch. */
function fakeClient(statuses: Job["status"][]) {
  let reads = 0;
  let current: Job["status"] | undefined;
  const calls = { refetch: 0, invalidate: 0 };
  return {
    calls,
    client: {
      refetchQueries: async () => {
        calls.refetch += 1;
        current = statuses[Math.min(reads++, statuses.length - 1)];
      },
      getQueryData: <T>() => ({ status: current }) as T,
      invalidateQueries: async () => {
        calls.invalidate += 1;
      },
    },
  };
}

describe("after a close, the job page", () => {
  it("keeps refreshing until Bursar shows the job closed, then refreshes everything once", async () => {
    const { client, calls } = fakeClient(["ACTIVE", "ACTIVE", "CLOSED"]);
    expect(await followIndexer(client, "j1", "closeJob", 1, 10)).toBe(true);
    expect(calls.refetch).toBe(3);
    expect(calls.invalidate).toBe(1);
  });

  it("gives up after its tries, still refreshing once", async () => {
    const { client, calls } = fakeClient(["ACTIVE"]);
    expect(await followIndexer(client, "j1", "closeJob", 1, 4)).toBe(false);
    expect(calls.refetch).toBe(4);
    expect(calls.invalidate).toBe(1);
  });

  it("waits for the right status for each action", async () => {
    const { client } = fakeClient(["ACTIVE", "PAUSED"]);
    expect(await followIndexer(client, "j1", "pause", 1, 5)).toBe(true);
  });
});
