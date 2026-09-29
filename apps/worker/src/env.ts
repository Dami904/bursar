import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key");

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ARC_RPC_URL: z.string().url(),
  ARC_CHAIN_ID: z.coerce.number().int().positive(),
  USDC_ADDRESS: address,
  JOB_VAULT_ADDRESS: address,
  /** Block the vault was deployed at: where the indexer starts on an empty database. */
  JOB_VAULT_DEPLOY_BLOCK: z.coerce.number().int().nonnegative(),
  OPERATOR_PRIVATE_KEY: privateKey,
  CIRCLE_API_KEY: z.string().min(1),
  CIRCLE_ENTITY_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/),
  CIRCLE_WALLET_SET_ID: z.string().uuid(),
  /** AuditAnchor on Arc. Without it the audit log is still kept, just not anchored. */
  AUDIT_ANCHOR_ADDRESS: address.optional(),
  /** Anchor the audit log head at least this often (when there's anything new)… */
  ANCHOR_INTERVAL_MS: z.coerce.number().int().min(10_000).default(600_000),
  /** …or as soon as this many entries are waiting. */
  ANCHOR_EVERY_ENTRIES: z.coerce.number().int().min(1).default(50),
  /** The console's address, for links in alerts. */
  WEB_URL: z.string().url().default("http://localhost:5173"),
  /** Telegram alerts (bot from @BotFather). Optional. */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  /** Local development only: let webhooks reach 127.0.0.1. */
  ALLOW_PRIVATE_WEBHOOKS: z.enum(["true", "false"]).default("false"),
  /** Local development only: pay sellers on 127.0.0.1 (same flag as the API's). */
  ALLOW_PRIVATE_PAYEES: z.enum(["true", "false"]).default("false"),
  /** Where automatic operator runs reach the Bursar API. */
  BURSAR_API_URL: z.string().url().default("http://127.0.0.1:8787"),
  /** "false" turns off automatic operator runs even when a model key is set. */
  AUTOPILOT: z.enum(["true", "false"]).default("true"),
  /** The public demo job: its brief rotates, and its approvals are signed by a demo approver. */
  DEMO_JOB_ID: z.string().uuid().optional(),
  DEMO_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(3 * 3600_000),
  /** The demo approver's Bursar key (bsr_apr_…) and wallet; both needed to auto-approve. */
  DEMO_APPROVER_KEY: z.string().min(1).optional(),
  DEMO_APPROVER_PRIVATE_KEY: privateKey.optional(),
  WORKER_TICK_MS: z.coerce.number().int().min(250).default(2000),
  /** How often to sweep leftover dust out of idle job wallets. */
  WORKER_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(300_000),
});

export type WorkerEnv = z.infer<typeof schema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv): WorkerEnv {
  return schema.parse(source);
}
