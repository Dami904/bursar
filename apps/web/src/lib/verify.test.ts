import {
  entryHash as serverEntryHash,
  payloadHashOf as serverPayloadHash,
  GENESIS_HASH,
} from "@bursar/db";
import { describe, expect, it } from "vitest";
import { canonicalJson, entryHash, payloadHashOf, verifyEntries } from "./verify.js";

// A payload shaped like a real decision entry (as stored: bigints and dates already strings).
const payload = {
  id: "f139bf3d-d213-4a96-9c0b-e159be41be90",
  amount: "20000",
  reasoning: 'Invoice "INV-2026-041", scene 2 — delivered ✓',
  checks: [
    { check: "JOB_NOT_ACTIVE", passed: true },
    { passed: true, check: "PAYEE_NOT_ALLOWED" },
  ],
  category: null,
  createdAt: "2026-09-28T13:15:02.123Z",
};

describe("browser verification matches the server's audit log", () => {
  it("hashes payloads exactly like the server", async () => {
    expect(await payloadHashOf(payload)).toBe(serverPayloadHash(payload));
  });

  it("links entries exactly like the server", async () => {
    const p = serverPayloadHash(payload);
    expect(await entryHash(GENESIS_HASH, 7, p)).toBe(serverEntryHash(GENESIS_HASH, 7, p));
  });

  it("sorts keys, so key order in stored JSON doesn't matter", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it("catches an edited payload", async () => {
    const payloadHash = serverPayloadHash(payload);
    const hash = serverEntryHash(GENESIS_HASH, 1, payloadHash);
    const entry = { seq: 1, prevHash: GENESIS_HASH, payloadHash, hash, payload };
    expect(await verifyEntries([entry])).toEqual({ ok: true, seq: null });
    const edited = { ...entry, payload: { ...payload, amount: "2000000" } };
    expect(await verifyEntries([edited])).toEqual({ ok: false, seq: 1 });
  });
});
