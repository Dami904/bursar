import { MARKETPLACES } from "@bursar/payments";
import { badRequest } from "../http/errors.js";

export type PayeeKind = "X402_ORIGIN" | "ADDRESS" | "MARKETPLACE";

/**
 * One canonical form per payee, so the allow-list can't be dodged with a trailing slash, a path,
 * different letter case or a default port.
 */
export function normalizePayee(kind: PayeeKind, value: string): string {
  if (kind === "MARKETPLACE") {
    // A marketplace is allowed by its id, and only one Bursar knows how to read.
    if (MARKETPLACES[value] === undefined) {
      throw badRequest(
        `Unknown marketplace "${value}". Known: ${Object.keys(MARKETPLACES).join(", ")}`,
      );
    }
    return value;
  }
  if (kind === "ADDRESS") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw badRequest("An address payee must be a 0x-prefixed 20-byte hex address");
    }
    return value.toLowerCase();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest("An x402 payee must be a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw badRequest("An x402 payee must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw badRequest("An x402 payee URL can't contain credentials");
  }
  return url.origin;
}
