import { lookup as lookupCallback, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

export class UnsafeUrlError extends Error {
  override readonly name = "UnsafeUrlError";
}

/**
 * Every range Bursar's server must never connect to on someone else's say-so: loopback, private,
 * link-local (cloud metadata lives at 169.254.169.254), CGNAT, benchmarking, documentation,
 * multicast and reserved. Node's BlockList also matches IPv4 addresses written as IPv6
 * (`::ffff:7f00:1` is 127.0.0.1), which string checks miss.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible (::a.b.c.d)
  ["64:ff9b::", 96], // NAT64: reaches IPv4 through a translator
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 32], // Teredo tunnels
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 tunnels
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True for any address in a non-public range, however it's written. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an address at all: refuse rather than guess
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Refuses URLs Bursar's server must never fetch on an agent's behalf: non-http(s), embedded
 * credentials, and hosts that resolve to any non-public address (every resolved address is
 * checked, so a hostname can't hide one private IP among public ones).
 *
 * This is the early, readable refusal. The connection itself is guarded too (see
 * `publicFetchOptions`), so a hostname that changes its answer between this check and the
 * request (DNS rebinding) still can't reach a private address.
 *
 * `allowPrivate` exists for local development against a seller on 127.0.0.1 only.
 */
export async function assertFetchable(rawUrl: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https URLs can be paid");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("URLs with embedded credentials are refused");
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError(`${url.hostname} resolves to a non-public address`);
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** DNS lookup for outbound connections that fails if the name resolves to any private address. */
function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
  lookupCallback(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      const refused = new UnsafeUrlError(`${hostname} resolves to a non-public address`);
      return callback(refused as NodeJS.ErrnoException, []);
    }
    if (options.all) return callback(null, list);
    const first = list[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
}

/** Connects only to public addresses, checked at connection time (closes DNS rebinding). */
const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/**
 * Extra `fetch` options for requests to URLs someone else chose (sellers, catalogs, webhooks):
 * the connection itself refuses private addresses. Empty when private hosts are allowed (local
 * development).
 */
export function publicFetchOptions(allowPrivate: boolean): RequestInit {
  return allowPrivate ? {} : ({ dispatcher: publicOnly } as unknown as RequestInit);
}
