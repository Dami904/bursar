import { HttpError } from "./errors.js";

/**
 * In-memory token buckets. The API runs as one process, so memory is the right store: no extra
 * service, nothing to fail over. Each key gets `limit` requests, refilled evenly over `windowMs`,
 * so a burst is allowed and a steady flood is not.
 */
export interface Limit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitConfig {
  /** Wallet sign-in (nonce and verify), per client IP. */
  readonly signIn: Limit;
  /** The public demo and public metrics, per client IP. */
  readonly public: Limit;
  /** Requests with a missing or wrong key, per client IP: slows down key guessing. */
  readonly badKey: Limit;
  /** Everything a key does, per key. */
  readonly perKey: Limit;
  /** Spending calls (purchase, request, invoice, quote, helpers), per key. */
  readonly spend: Limit;
}

const minute = 60_000;

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  signIn: { limit: 20, windowMs: minute },
  public: { limit: 120, windowMs: minute },
  badKey: { limit: 30, windowMs: minute },
  perKey: { limit: 600, windowMs: minute },
  spend: { limit: 60, windowMs: minute },
};

export interface Verdict {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until one more request is allowed (0 when allowed). */
  readonly retryAfter: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

/** Buckets for one kind of limit. Idle buckets are dropped once the map grows large. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rule: Limit,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Takes one token for `key` if there is one. */
  take(key: string): Verdict {
    return this.update(key, 1);
  }

  /** Looks without taking. */
  peek(key: string): Verdict {
    return this.update(key, 0);
  }

  private update(key: string, cost: number): Verdict {
    const now = this.now();
    const rate = this.rule.limit / this.rule.windowMs;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      bucket = { tokens: this.rule.limit, updated: now };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.rule.limit, bucket.tokens + (now - bucket.updated) * rate);
      bucket.updated = now;
    }
    if (bucket.tokens >= Math.max(cost, 1)) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        limit: this.rule.limit,
        remaining: Math.floor(bucket.tokens),
        retryAfter: 0,
      };
    }
    return {
      allowed: false,
      limit: this.rule.limit,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / rate / 1000)),
    };
  }

  /** Drops buckets that have refilled completely: they hold nothing a new bucket wouldn't. */
  private sweep(now: number) {
    const rate = this.rule.limit / this.rule.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updated) * rate >= this.rule.limit) {
        this.buckets.delete(key);
      }
    }
  }
}

export class RateLimitedError extends HttpError {
  constructor(readonly verdict: Verdict) {
    super(
      429,
      "RATE_LIMITED",
      `Too many requests. Try again in ${verdict.retryAfter} second${verdict.retryAfter === 1 ? "" : "s"}.`,
    );
  }
}

/**
 * The client's address. Behind Render (and its Cloudflare edge), `cf-connecting-ip` is set by the
 * edge and can't be forged through it; otherwise the first `x-forwarded-for` hop. Only trusted when
 * the server says it sits behind a proxy.
 */
export function clientIp(
  header: (name: string) => string | undefined,
  trustProxy: boolean,
): string {
  if (!trustProxy) return "direct";
  const edge = header("cf-connecting-ip")?.trim();
  if (edge) return edge;
  const forwarded = header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
