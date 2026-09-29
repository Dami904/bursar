import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb } from "@bursar/db";
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
    /** The job shown read-only at /demo. */
    DEMO_JOB_ID: z.string().uuid().optional(),
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
  demoJobId: env.DEMO_JOB_ID,
  siwe: { domains: webOrigins.map((origin) => new URL(origin).host), chainId: env.ARC_CHAIN_ID },
});

serve({ fetch: app.fetch, port: env.API_PORT, hostname: env.HOST }, (info) => {
  process.stdout.write(`Bursar API listening on http://${env.HOST}:${info.port}\n`);
});
