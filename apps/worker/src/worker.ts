import { backfillDecisions, computeMetrics, createDb, jobs, metricsDaily } from "@bursar/db";
import { bursarClient, hasModelKey, providerFromEnv, runOperator } from "@bursar/operator";
import { CircleWalletProvider } from "@bursar/payments";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";
import type { WorkerEnv } from "./env.js";
import { deliverAlerts, pollTelegram, produceAlerts } from "./alerts.js";
import { anchorOnce } from "./anchor.js";
import { autopilotOnce } from "./autopilot.js";
import { approveDemoPayments, rotateDemoBrief } from "./demo.js";
import { executeOnce } from "./executor.js";
import { indexOnce } from "./indexer.js";
import { log } from "./log.js";
import { reconcileOnce } from "./reconciler.js";

/** Any fixed number: every Bursar worker competes for this one advisory lock. */
const WORKER_LOCK = 4_242_001;

export interface RunningWorker {
  stop(): Promise<void>;
}

/**
 * Starts the worker loop: index vault events, then advance purchases, every tick. Only one worker
 * runs at a time (a Postgres advisory lock), so releases are sent one after another from a single
 * operator key and nonces can't collide. Returns null if another worker holds the lock.
 */
export async function startWorker(env: WorkerEnv): Promise<RunningWorker | null> {
  const { db, client: sql } = createDb(env.DATABASE_URL, { max: 5 });
  const lockConnection = await sql.reserve();
  const [row] = await lockConnection<
    { locked: boolean }[]
  >`select pg_try_advisory_lock(${WORKER_LOCK}) as locked`;
  if (row?.locked !== true) {
    log.warn("another worker holds the lock; not starting");
    lockConnection.release();
    await sql.end();
    return null;
  }

  const chain = env.ARC_CHAIN_ID === arc.id ? arc : arcTestnet;
  const transport = http(env.ARC_RPC_URL, { retryCount: 3, retryDelay: 500, timeout: 20_000 });
  // cacheTime 0: the indexer must see the real head, not a block number cached for seconds.
  const client = createPublicClient({ chain, transport, cacheTime: 0 });
  const operator = createWalletClient({
    chain,
    transport,
    account: privateKeyToAccount(env.OPERATOR_PRIVATE_KEY as Hex),
  });
  const wallets = new CircleWalletProvider({
    apiKey: env.CIRCLE_API_KEY,
    entitySecret: env.CIRCLE_ENTITY_SECRET,
    walletSetId: env.CIRCLE_WALLET_SET_ID,
    blockchain: chain.id === arc.id ? "ARC" : "ARC-TESTNET",
  });
  const vault = env.JOB_VAULT_ADDRESS as Hex;

  /** Saves today's traction numbers (global and per business), at most once an hour. */
  let lastSnapshotAt = 0;
  async function snapshotMetrics() {
    if (Date.now() - lastSnapshotAt < 3_600_000) return;
    lastSnapshotAt = Date.now();
    const day = new Date().toISOString().slice(0, 10);
    const network = chain.id === arc.id ? "mainnet" : "testnet";
    const owners = await db.selectDistinct({ ownerId: jobs.ownerId }).from(jobs);
    for (const scope of [null, ...owners.map((o) => o.ownerId)]) {
      const data = await computeMetrics(db, scope);
      await db
        .insert(metricsDaily)
        .values({ day, network, scope: scope ?? "global", data })
        .onConflictDoUpdate({
          target: [metricsDaily.day, metricsDaily.network, metricsDaily.scope],
          set: { data, updatedAt: new Date() },
        });
    }
  }

  // Decisions made before the audit log existed join it once, in the order they were made.
  const backfilled = await backfillDecisions(db);
  if (backfilled > 0) log.info("audit log backfilled", { decisions: backfilled });

  // Automatic operator runs: only with a model key, and off with AUTOPILOT=false.
  const autopilot =
    env.AUTOPILOT === "true" && hasModelKey()
      ? {
          db,
          running: new Set<string>(),
          retries: new Map<string, { attempts: number; after: number }>(),
          run: async ({ brief, key }: { brief: string; key: string }) =>
            runOperator({
              provider: providerFromEnv(),
              bursar: bursarClient(env.BURSAR_API_URL, key),
              brief,
              log: (event, fields) => log.info(`operator: ${event}`, fields),
            }),
        }
      : null;
  if (autopilot === null) log.info("autopilot off (no model key, or AUTOPILOT=false)");

  const demo =
    env.DEMO_JOB_ID === undefined || autopilot === null
      ? null
      : {
          db,
          jobId: env.DEMO_JOB_ID,
          intervalMs: env.DEMO_INTERVAL_MS,
          running: autopilot.running,
          ...(env.DEMO_APPROVER_KEY && env.DEMO_APPROVER_PRIVATE_KEY
            ? {
                approver: {
                  apiUrl: env.BURSAR_API_URL,
                  key: env.DEMO_APPROVER_KEY,
                  privateKey: env.DEMO_APPROVER_PRIVATE_KEY,
                  afterMs: 60_000,
                },
              }
            : {}),
        };

  let running = true;
  const loop = (async () => {
    log.info("worker started", { operator: operator.account.address, vault, chainId: chain.id });
    while (running) {
      const started = Date.now();
      try {
        // Catch up on events first, so purchases see jobs that just went live on-chain.
        for (
          let i = 0;
          i < 10 &&
          (await indexOnce({
            db,
            client,
            vault,
            deployBlock: BigInt(env.JOB_VAULT_DEPLOY_BLOCK),
          })) > 0n;
          i += 1
        ) {
          // keep reading while there's backlog
        }
      } catch (error) {
        log.error("indexer tick failed", error);
      }
      try {
        await executeOnce({ db, client, operator, vault, usdc: env.USDC_ADDRESS as Hex, wallets });
      } catch (error) {
        log.error("executor tick failed", error);
      }
      try {
        await reconcileOnce({
          db,
          client,
          operator,
          vault,
          usdc: env.USDC_ADDRESS as Hex,
          wallets,
          sweepIntervalMs: env.WORKER_SWEEP_INTERVAL_MS,
        });
      } catch (error) {
        log.error("reconciler tick failed", error);
      }
      if (env.AUDIT_ANCHOR_ADDRESS !== undefined) {
        try {
          await anchorOnce({
            db,
            client,
            operator,
            anchor: env.AUDIT_ANCHOR_ADDRESS as Hex,
            intervalMs: env.ANCHOR_INTERVAL_MS,
            everyEntries: env.ANCHOR_EVERY_ENTRIES,
          });
        } catch (error) {
          log.error("anchor tick failed", error);
        }
      }
      try {
        const alertDeps = {
          db,
          webUrl: env.WEB_URL,
          telegramToken: env.TELEGRAM_BOT_TOKEN,
          allowPrivateWebhooks: env.ALLOW_PRIVATE_WEBHOOKS === "true",
        };
        await pollTelegram(alertDeps);
        await produceAlerts(alertDeps);
        await deliverAlerts(alertDeps);
      } catch (error) {
        log.error("alerts tick failed", error);
      }
      if (demo !== null) {
        try {
          await rotateDemoBrief(demo);
          await approveDemoPayments(demo);
        } catch (error) {
          log.error("demo tick failed", error);
        }
      }
      if (autopilot !== null) {
        try {
          await autopilotOnce(autopilot);
        } catch (error) {
          log.error("autopilot tick failed", error);
        }
      }
      try {
        await snapshotMetrics();
      } catch (error) {
        log.error("metrics snapshot failed", error);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, env.WORKER_TICK_MS - (Date.now() - started))),
      );
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
      await lockConnection`select pg_advisory_unlock(${WORKER_LOCK})`;
      lockConnection.release();
      await sql.end();
      log.info("worker stopped");
    },
  };
}
