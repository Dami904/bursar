import { publicFetchOptions } from "./ssrf.js";

/**
 * Marketplaces: directories of paid x402 endpoints. An owner can allow a whole marketplace instead
 * of naming each seller; Bursar then lets the agent buy only what the marketplace lists for our
 * network, at no more than the listed price. Listings are seller-written: untrusted text.
 */
export interface Listing {
  /** e.g. "Exa". */
  readonly service: string;
  /** Who runs the endpoint, e.g. "Orthogonal" for a service it resells. */
  readonly provider: string;
  readonly category: string;
  readonly method: "GET" | "POST";
  /** Full URL; path parameters stay as {name} placeholders. */
  readonly url: string;
  /** Listed price in USDC base units (6 decimals). */
  readonly price: bigint;
  /** CAIP-2 networks the endpoint takes payment on. */
  readonly networks: readonly string[];
  readonly description: string;
}

export interface MarketplaceSource {
  /** Stable id stored in allow-lists, e.g. "circle-agents". */
  readonly id: string;
  readonly name: string;
  readonly homepage: string;
  fetchListings(): Promise<Listing[]>;
}

export class MarketplaceError extends Error {
  override readonly name = "MarketplaceError";
}

const maxDescription = 300;

/** USDC base units from a listing's decimal price; null for anything that isn't a sane price. */
export function listedUnits(amount: unknown): bigint | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
    return null;
  }
  // Six decimals is USDC's precision; a listing can't price finer than that.
  const [whole = "0", fraction = ""] = amount.toFixed(6).split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

interface CircleService {
  name?: unknown;
  category?: unknown;
  status?: unknown;
  baseUrl?: unknown;
  provider?: { name?: unknown };
  endpoints?: {
    method?: unknown;
    path?: unknown;
    description?: unknown;
    baseUrl?: unknown;
    networks?: unknown;
    pricing?: { amount?: unknown; currency?: unknown };
  }[];
}

/** Circle's Agent Marketplace (agents.circle.com): the listing its own services page reads. */
export function circleAgentMarketplace(
  url = "https://agents.circle.com/api/v1/internal/x402/services?limit=200",
): MarketplaceSource {
  return {
    id: "circle-agents",
    name: "Circle Agent Marketplace",
    homepage: "https://agents.circle.com/services",
    async fetchListings() {
      let response: Response;
      try {
        response = await fetch(url, {
          ...publicFetchOptions(false),
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
          headers: { accept: "application/json" },
        });
      } catch (error) {
        throw new MarketplaceError(
          `Circle's marketplace didn't answer: ${(error as Error).message}`,
        );
      }
      if (!response.ok)
        throw new MarketplaceError(`Circle's marketplace answered ${response.status}`);
      const body = (await response.json().catch(() => null)) as { services?: unknown } | null;
      if (body === null || !Array.isArray(body.services)) {
        throw new MarketplaceError("Circle's marketplace listing isn't in the expected shape");
      }
      const listings: Listing[] = [];
      for (const raw of body.services as CircleService[]) {
        if (raw.status !== "active" || !Array.isArray(raw.endpoints)) continue;
        for (const e of raw.endpoints) {
          const method = e.method === "POST" ? "POST" : e.method === "GET" ? "GET" : null;
          const base = typeof e.baseUrl === "string" ? e.baseUrl : raw.baseUrl;
          const price = e.pricing?.currency === "USDC" ? listedUnits(e.pricing.amount) : null;
          if (method === null || typeof base !== "string" || typeof e.path !== "string") continue;
          // A free endpoint isn't something to pay for; a missing price is something to refuse.
          if (price === null || price === 0n) continue;
          let full: URL;
          try {
            full = new URL(e.path, base);
          } catch {
            continue;
          }
          if (full.protocol !== "https:") continue;
          listings.push({
            service: String(raw.name ?? ""),
            provider: String(raw.provider?.name ?? ""),
            category: String(raw.category ?? ""),
            method,
            url: `${full.origin}${safeDecode(full.pathname)}`,
            price,
            networks: Array.isArray(e.networks)
              ? e.networks.filter((n) => typeof n === "string")
              : [],
            description: String(e.description ?? "").slice(0, maxDescription),
          });
        }
      }
      return listings;
    },
  };
}

/** The marketplaces an owner can allow, by id. */
export const MARKETPLACES: Record<string, MarketplaceSource> = {
  "circle-agents": circleAgentMarketplace(),
};

/** Adds or replaces a marketplace (tests use a local one). */
export function registerMarketplace(source: MarketplaceSource): void {
  MARKETPLACES[source.id] = source;
}

const FRESH_MS = 10 * 60_000;
/** A listing older than this is never trusted: no fresh copy means no marketplace purchases. */
const STALE_LIMIT_MS = 60 * 60_000;
const cache = new Map<string, { at: number; listings: Listing[]; pending?: Promise<Listing[]> }>();

/** The marketplace's listings, cached for 10 minutes; a stale copy serves for up to an hour. */
export async function listingsOf(id: string, now = Date.now()): Promise<Listing[]> {
  const source = MARKETPLACES[id];
  if (source === undefined) throw new MarketplaceError(`Unknown marketplace "${id}"`);
  const hit = cache.get(id);
  if (hit !== undefined && now - hit.at < FRESH_MS) return hit.listings;
  if (hit?.pending !== undefined) return hit.pending;
  const pending = source.fetchListings();
  cache.set(id, { at: hit?.at ?? 0, listings: hit?.listings ?? [], pending });
  try {
    const listings = await pending;
    cache.set(id, { at: now, listings });
    return listings;
  } catch (error) {
    if (hit !== undefined && now - hit.at < STALE_LIMIT_MS) {
      cache.set(id, { at: hit.at, listings: hit.listings });
      return hit.listings;
    }
    cache.delete(id);
    throw error;
  }
}

/** Forgets cached listings (tests). */
export function clearMarketplaceCache(): void {
  cache.clear();
}

/** Owner-chosen limits on what a marketplace entry allows. */
export interface MarketplaceFilters {
  /** Only these marketplace categories; empty or absent means any. */
  readonly categories?: readonly string[] | undefined;
  /** Never above this many USDC base units per call. */
  readonly maxPrice?: bigint | undefined;
}

function pathPattern(listingUrl: string): RegExp {
  const escaped = listingUrl.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === "{" || ch === "}" ? ch : `\\${ch}`,
  );
  // {param} matches one path segment.
  return new RegExp(`^${escaped.replace(/\{[^}/]+\}/g, "[^/?#]+")}$`);
}

const patterns = new Map<string, RegExp>();

/**
 * The listing a purchase is for: same origin, a path that fits the listing's template, the same
 * method, our network, and within the owner's filters. The query string doesn't take part.
 */
export function findListing(
  listings: readonly Listing[],
  url: string,
  method: "GET" | "POST",
  network: string,
  filters: MarketplaceFilters = {},
): Listing | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  let bare: string;
  try {
    bare = `${target.origin}${decodeURI(target.pathname)}`;
  } catch {
    return null; // malformed percent-encoding: not something any listing describes
  }
  for (const listing of listings) {
    if (listing.method !== method || !listing.networks.includes(network)) continue;
    if (!allowedBy(listing, filters)) continue;
    let pattern = patterns.get(listing.url);
    if (pattern === undefined) {
      pattern = pathPattern(listing.url);
      patterns.set(listing.url, pattern);
    }
    if (pattern.test(bare)) return listing;
  }
  return null;
}

function allowedBy(listing: Listing, filters: MarketplaceFilters): boolean {
  const categories = filters.categories ?? [];
  if (categories.length > 0 && !categories.includes(listing.category)) return false;
  return filters.maxPrice === undefined || listing.price <= filters.maxPrice;
}

/**
 * Listings for an agent to choose from: on our network, within the filters, best text match
 * first (service, category and description), then cheapest.
 */
export function searchListings(
  listings: readonly Listing[],
  query: string,
  network: string,
  filters: MarketplaceFilters = {},
  limit = 20,
): Listing[] {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 1);
  const scored = listings
    .filter((l) => l.networks.includes(network) && allowedBy(l, filters))
    .map((l) => {
      const text =
        `${l.service} ${l.provider} ${l.category} ${l.description} ${l.url}`.toLowerCase();
      return { l, score: words.reduce((sum, w) => sum + (text.includes(w) ? 1 : 0), 0) };
    })
    .filter((s) => words.length === 0 || s.score > 0);
  scored.sort(
    (a, b) => b.score - a.score || (a.l.price < b.l.price ? -1 : a.l.price > b.l.price ? 1 : 0),
  );
  return scored.slice(0, Math.max(1, Math.min(limit, 50))).map((s) => s.l);
}
