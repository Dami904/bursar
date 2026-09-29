import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { RateLimiter, clientIp, type RateLimitConfig } from "../src/http/rate-limit.js";
import { db, seedJob } from "./support.js";

const tight: RateLimitConfig = {
  signIn: { limit: 3, windowMs: 60_000 },
  public: { limit: 3, windowMs: 60_000 },
  badKey: { limit: 3, windowMs: 60_000 },
  perKey: { limit: 100, windowMs: 60_000 },
  spend: { limit: 2, windowMs: 60_000 },
};

function request(
  app: ReturnType<typeof createApp>,
  path: string,
  options: { key?: string; ip?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.key !== undefined) headers.authorization = `Bearer ${options.key}`;
  if (options.ip !== undefined) headers["cf-connecting-ip"] = options.ip;
  return app.request(path, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("RateLimiter", () => {
  it("allows a burst up to the limit, then refuses with how long to wait", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 }, () => now);
    expect([1, 2, 3].map(() => limiter.take("a").allowed)).toEqual([true, true, true]);
    const refused = limiter.take("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBe(20); // one token refills every 20 s
    expect(limiter.take("b").allowed).toBe(true); // keys don't share
    now = 20_000;
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
  });

  it("drops idle buckets once it holds too many keys", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000 }, () => now, 2);
    limiter.take("a");
    limiter.take("b");
    now = 5_000; // both refilled: safe to forget
    limiter.take("c");
    expect(limiter.take("a").allowed).toBe(true);
  });
});

describe("clientIp", () => {
  const headers =
    (values: Record<string, string>) =>
    (name: string): string | undefined =>
      values[name];

  it("ignores forwarding headers unless the server is behind a proxy", () => {
    expect(clientIp(headers({ "x-forwarded-for": "1.2.3.4" }), false)).toBe("direct");
  });

  it("prefers the edge's address, then the first forwarded hop", () => {
    expect(
      clientIp(headers({ "cf-connecting-ip": "5.6.7.8", "x-forwarded-for": "1.2.3.4" }), true),
    ).toBe("5.6.7.8");
    expect(clientIp(headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }), true)).toBe("1.2.3.4");
  });
});

describe("API rate limits", () => {
  it("limits wallet sign-in per address, with Retry-After", async () => {
    const app = createApp(db, { rateLimits: tight, trustProxy: true });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app, "/auth/nonce", { ip: "9.9.9.1", body: {} })).status).not.toBe(429);
    }
    const limited = await request(app, "/auth/nonce", { ip: "9.9.9.1", body: {} });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("20");
    expect(((await limited.json()) as { error: string }).error).toBe("RATE_LIMITED");
    // Someone else isn't affected.
    expect((await request(app, "/auth/nonce", { ip: "9.9.9.2", body: {} })).status).not.toBe(429);
  });

  it("slows down an address that keeps sending bad keys", async () => {
    const app = createApp(db, { rateLimits: tight, trustProxy: true });
    const { ownerKey } = await seedJob();
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app, "/jobs", { key: `bsk_wrong_${i}`, ip: "8.8.8.1" })).status).toBe(
        401,
      );
    }
    expect((await request(app, "/jobs", { key: "bsk_wrong_x", ip: "8.8.8.1" })).status).toBe(429);
    // A real key from another address still works.
    expect((await request(app, "/jobs", { key: ownerKey, ip: "8.8.8.2" })).status).toBe(200);
  });

  it("limits spending calls per key, not per job", async () => {
    const app = createApp(db, { rateLimits: tight, trustProxy: true });
    const { agents } = await seedJob({ agents: 2 });
    const payload = (op: string) => ({
      operationId: op,
      payee: { kind: "X402_ORIGIN", value: "https://seller.example.com" },
      amount: "0.01",
      reasoning: "rate limit test",
    });
    const first = agents[0]!.key;
    expect(
      (await request(app, "/spend/request", { key: first, body: payload("op-rl-00001") })).status,
    ).not.toBe(429);
    expect(
      (await request(app, "/spend/request", { key: first, body: payload("op-rl-00002") })).status,
    ).not.toBe(429);
    const limited = await request(app, "/spend/request", {
      key: first,
      body: payload("op-rl-00003"),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    // Reading the budget isn't a spending call, and the other agent has its own allowance.
    expect((await request(app, "/spend/budget", { key: first })).status).toBe(200);
    const second = agents[1]!.key;
    expect(
      (await request(app, "/spend/request", { key: second, body: payload("op-rl-00004") })).status,
    ).not.toBe(429);
  });

  it("limits the public demo per address", async () => {
    const app = createApp(db, { rateLimits: tight, trustProxy: true });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app, "/demo", { ip: "7.7.7.1" })).status).not.toBe(429);
    }
    expect((await request(app, "/demo", { ip: "7.7.7.1" })).status).toBe(429);
  });

  it("can be turned off", async () => {
    const app = createApp(db, { rateLimits: false, trustProxy: true });
    for (let i = 0; i < 25; i += 1) {
      expect((await request(app, "/auth/nonce", { ip: "6.6.6.1", body: {} })).status).not.toBe(429);
    }
  });
});
