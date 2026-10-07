import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb } from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import { CircleWalletProvider } from "@bursar/payments";
import { z } from "zod";
import { createApp } from "./app.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env file: rely on the process environment (e.g. in a deployment).
}

const env = z
  .object({
    DATABASE_URL: z.string().url(),
    API_PORT: z.coerce.number().int().positive().default(8787),
    HOST: z.string().default("127.0.0.1"),
    ARC_CHAIN_ID: z.coerce.number().int().positive(),
    USDC_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    CIRCLE_API_KEY: z.string().min(1),
    CIRCLE_ENTITY_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/),
    CIRCLE_WALLET_SET_ID: z.string().uuid(),
    /** Local development only: lets agents buy from a seller on 127.0.0.1. Never set in production. */
    ALLOW_PRIVATE_PAYEES: z.enum(["true", "false"]).default("false"),
    PURCHASE_WAIT_MS: z.coerce.number().int().nonnegative().default(45_000),
    JOB_VAULT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    /** Where the console is served from, comma-separated. Also the domains wallets sign in for. */
    WEB_ORIGINS: z.string().default("http://localhost:5173"),
    /** The Telegram bot's @username (without @), for alert links. */
    TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
    /** Arc mainnet while it's new: the most any one job may spend, in USDC (e.g. "5"). */
    MAX_JOB_BUDGET: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/, "a USDC amount, like 5 or 2.50")
      .optional(),
    /**
     * The job shown read-only at /demo. PUBLIC_JOB_ID shows a job without the testnet demo's
     * automation (brief rotation, auto-approval), which DEMO_JOB_ID also turns on in the worker.
     */
    PUBLIC_JOB_ID: z.string().uuid().optional(),
    /** The job shown read-only at /demo. */
    DEMO_JOB_ID: z.string().uuid().optional(),
    /** "on-demand" (default): visitors run the demo's scenes with a click. "auto": it runs on a timer, no button. */
    DEMO_MODE: z.enum(["on-demand", "auto"]).default("on-demand"),
    /** Demo pacing: the least time between scenes, the most per 24 hours, and when the budget must last until. */
    DEMO_COOLDOWN_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(5 * 60_000),
    DEMO_MAX_RUNS_PER_DAY: z.coerce.number().int().min(1).default(10),
    DEMO_LASTS_UNTIL: z.coerce.date().default(new Date("2026-11-03T00:00:00Z")),
  })
  .parse(process.env);

const webOrigins = env.WEB_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const { db } = createDb(env.DATABASE_URL);
const app = createApp(db, {
  wallets: new CircleWalletProvider({
    apiKey: env.CIRCLE_API_KEY,
    entitySecret: env.CIRCLE_ENTITY_SECRET,
    walletSetId: env.CIRCLE_WALLET_SET_ID,
    blockchain: env.ARC_CHAIN_ID === 5042 ? "ARC" : "ARC-TESTNET",
  }),
  payments: {
    network: `eip155:${env.ARC_CHAIN_ID}`,
    asset: env.USDC_ADDRESS,
    allowPrivateHosts: env.ALLOW_PRIVATE_PAYEES === "true",
    waitMs: env.PURCHASE_WAIT_MS,
  },
  chain: { chainId: env.ARC_CHAIN_ID, vault: env.JOB_VAULT_ADDRESS as `0x${string}` },
  webOrigins: webOrigins,
  telegramBot: env.TELEGRAM_BOT_USERNAME,
  demoJobId: env.PUBLIC_JOB_ID ?? env.DEMO_JOB_ID,
  // The click-to-run button belongs to the demo job that the worker automates, not a plain public job.
  demoRun:
    env.DEMO_JOB_ID !== undefined &&
    env.PUBLIC_JOB_ID === undefined &&
    env.DEMO_MODE === "on-demand"
      ? {
          cooldownMs: env.DEMO_COOLDOWN_MS,
          maxPerDay: env.DEMO_MAX_RUNS_PER_DAY,
          lastsUntil: env.DEMO_LASTS_UNTIL,
          reserveMicros: 100_000n,
        }
      : undefined,
  // The worker runs the operator with a model key unless AUTOPILOT=false (same process).
  operatorAvailable:
    process.env.AUTOPILOT !== "false" &&
    ((process.env.OPERATOR_PROVIDER ?? "gemini") === "claude"
      ? Boolean(process.env.ANTHROPIC_API_KEY)
      : Boolean(process.env.GEMINI_API_KEY)),
  ...(env.MAX_JOB_BUDGET === undefined ? {} : { maxJobBudget: parseUsdc(env.MAX_JOB_BUDGET) }),
  logRequests: true,
  // Render (and its Cloudflare edge) forward the client's address.
  trustProxy: true,
  siwe: { domains: webOrigins.map((origin) => new URL(origin).host), chainId: env.ARC_CHAIN_ID },
});

serve({ fetch: app.fetch, port: env.API_PORT, hostname: env.HOST }, (info) => {
  process.stdout.write(`Bursar API listening on http://${env.HOST}:${info.port}\n`);
});
