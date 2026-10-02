import { afterEach, describe, expect, it } from "vitest";
import {
  MarketplaceError,
  clearMarketplaceCache,
  findListing,
  listedUnits,
  listingsOf,
  registerMarketplace,
  searchListings,
  type Listing,
} from "../src/index.js";

const ARC = "eip155:5042";

const listing = (overrides: Partial<Listing>): Listing => ({
  service: "Exa",
  provider: "Exa",
  category: "Web Search Research",
  method: "POST",
  url: "https://api.exa.ai/search",
  price: 7_000n,
  networks: [ARC, "eip155:8453"],
  description: "AI web search",
  ...overrides,
});

const listings: Listing[] = [
  listing({}),
  listing({
    service: "DefiLlama",
    provider: "BlockRun.AI",
    category: "Financial Analysis",
    method: "GET",
    url: "https://arc.blockrun.ai/api/v1/defillama/prices/{coins}",
    price: 2_000n,
    networks: [ARC],
    description: "Token prices",
  }),
  listing({
    service: "Base only",
    category: "Data Enrichment",
    url: "https://base-only.example/v1/lookup",
    networks: ["eip155:8453"],
  }),
];

afterEach(() => clearMarketplaceCache());

describe("listed prices", () => {
  it("turns a listing's decimal price into USDC base units", () => {
    expect(listedUnits(0.007)).toBe(7_000n);
    expect(listedUnits(0.0085)).toBe(8_500n);
    expect(listedUnits(5.001)).toBe(5_001_000n);
    expect(listedUnits(0)).toBe(0n);
  });

  it("refuses anything that isn't a sane price", () => {
    expect(listedUnits("0.01")).toBeNull();
    expect(listedUnits(-1)).toBeNull();
    expect(listedUnits(Number.NaN)).toBeNull();
    expect(listedUnits(10_000_000)).toBeNull();
  });
});

describe("matching a purchase to a listing", () => {
  it("matches the exact endpoint, method and network", () => {
    expect(findListing(listings, "https://api.exa.ai/search", "POST", ARC)?.service).toBe("Exa");
  });

  it("fills a path template with one segment, and ignores the query string", () => {
    const hit = findListing(
      listings,
      "https://arc.blockrun.ai/api/v1/defillama/prices/coingecko:ethereum?x=1",
      "GET",
      ARC,
    );
    expect(hit?.service).toBe("DefiLlama");
    expect(
      findListing(listings, "https://arc.blockrun.ai/api/v1/defillama/prices/a/b", "GET", ARC),
    ).toBeNull();
  });

  it("refuses another method, another network, another path or a look-alike host", () => {
    expect(findListing(listings, "https://api.exa.ai/search", "GET", ARC)).toBeNull();
    expect(findListing(listings, "https://api.exa.ai/search", "POST", "eip155:5042002")).toBeNull();
    expect(findListing(listings, "https://api.exa.ai/admin", "POST", ARC)).toBeNull();
    expect(findListing(listings, "https://api.exa.ai.evil.example/search", "POST", ARC)).toBeNull();
    expect(findListing(listings, "https://base-only.example/v1/lookup", "POST", ARC)).toBeNull();
  });

  it("applies the owner's filters: categories and a most-per-call price", () => {
    const url = "https://api.exa.ai/search";
    expect(
      findListing(listings, url, "POST", ARC, { categories: ["Financial Analysis"] }),
    ).toBeNull();
    expect(
      findListing(listings, url, "POST", ARC, { categories: ["Web Search Research"] }),
    ).not.toBeNull();
    expect(findListing(listings, url, "POST", ARC, { maxPrice: 5_000n })).toBeNull();
    expect(findListing(listings, url, "POST", ARC, { maxPrice: 7_000n })).not.toBeNull();
  });
});

describe("searching listings", () => {
  it("returns matches on our network, best match first, then cheapest", () => {
    const found = searchListings(listings, "token prices", ARC);
    expect(found.map((l) => l.service)).toEqual(["DefiLlama"]);
    expect(searchListings(listings, "", ARC).map((l) => l.service)).toEqual(["DefiLlama", "Exa"]);
  });

  it("keeps to the owner's filters", () => {
    expect(searchListings(listings, "", ARC, { maxPrice: 3_000n }).map((l) => l.service)).toEqual([
      "DefiLlama",
    ]);
  });
});

describe("reading a marketplace", () => {
  it("caches listings, serves a stale copy for a while, then refuses", async () => {
    let calls = 0;
    let up = true;
    registerMarketplace({
      id: "test-market",
      name: "Test",
      homepage: "https://test.example",
      fetchListings: async () => {
        calls += 1;
        if (!up) throw new MarketplaceError("down");
        return listings;
      },
    });
    const t0 = 1_000_000;
    expect(await listingsOf("test-market", t0)).toHaveLength(3);
    expect(await listingsOf("test-market", t0 + 60_000)).toHaveLength(3);
    expect(calls).toBe(1); // fresh for 10 minutes

    up = false;
    expect(await listingsOf("test-market", t0 + 20 * 60_000)).toHaveLength(3); // stale but < 1h
    await expect(listingsOf("test-market", t0 + 2 * 60 * 60_000)).rejects.toThrow(MarketplaceError);
  });

  it("refuses an unknown marketplace", async () => {
    await expect(listingsOf("nope")).rejects.toThrow(/Unknown marketplace/);
  });
});
