import { readFileSync } from "node:fs";
import type { PolicyInput } from "../src/index.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Vector {
  readonly name: string;
  readonly override: { [key: string]: Json };
  readonly expect: { readonly outcome: string; readonly reason?: string };
}

const file = JSON.parse(
  readFileSync(new URL("../vectors/policy-vectors.json", import.meta.url), "utf8"),
) as { base: { [key: string]: Json }; cases: Vector[] };

export const vectors: readonly Vector[] = file.cases;

function merge(base: Json, override: Json): Json {
  if (
    override === null ||
    typeof override !== "object" ||
    Array.isArray(override) ||
    base === null ||
    typeof base !== "object" ||
    Array.isArray(base)
  ) {
    return override;
  }
  const out: { [key: string]: Json } = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? merge(base[key] as Json, value) : value;
  }
  return out;
}

const moneyFields = new Set([
  "budget",
  "deposited",
  "committed",
  "perTxCap",
  "approvalThreshold",
  "windowCap",
  "windowSpent",
  "limit",
  "amount",
]);
const dateFields = new Set(["expiresAt", "windowStart", "now"]);

function revive(value: Json, key = ""): unknown {
  if (value === null) return null;
  if (typeof value === "string" && moneyFields.has(key)) return BigInt(value);
  if (typeof value === "string" && dateFields.has(key)) return new Date(value);
  if (Array.isArray(value)) return value.map((item) => revive(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v, k)]));
  }
  return value;
}

/** The fully resolved policy input for a vector: base with the vector's overrides applied. */
export function inputFor(vector: Pick<Vector, "override">): PolicyInput {
  return revive(merge(file.base, vector.override)) as PolicyInput;
}
