/**
 * The audit log's hashing, redone in the browser (same rules as packages/db/src/audit.ts):
 *   payloadHash = sha256(canonicalJson(payload))
 *   hash        = sha256(prevHash ‖ seq as 8 bytes big-endian ‖ payloadHash)
 * So nobody has to take the server's word for it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hex = (bytes: ArrayBuffer) =>
  `0x${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

const fromHex = (value: string) => {
  const clean = value.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export async function payloadHashOf(payload: unknown) {
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload))),
  );
}

export async function entryHash(prevHash: string, seq: number, payloadHash: string) {
  const bytes = new Uint8Array(32 + 8 + 32);
  bytes.set(fromHex(prevHash), 0);
  new DataView(bytes.buffer).setBigUint64(32, BigInt(seq));
  bytes.set(fromHex(payloadHash), 40);
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export interface AuditEntry {
  seq: number;
  hash: string;
  prevHash: string;
  payloadHash: string;
  payload: unknown;
}

/** Recomputes each entry's hashes from its payload and link. True only if every one matches. */
export async function verifyEntries(entries: AuditEntry[]) {
  for (const e of entries) {
    const payloadHash = await payloadHashOf(e.payload);
    if (payloadHash !== e.payloadHash) return { ok: false, seq: e.seq };
    if ((await entryHash(e.prevHash, e.seq, payloadHash)) !== e.hash)
      return { ok: false, seq: e.seq };
  }
  return { ok: true, seq: null };
}
