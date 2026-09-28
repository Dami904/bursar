import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** Micro-USDC. Always a bigint in TypeScript, never a JS number. */
const money = (name: string) => bigint(name, { mode: "bigint" });
const at = (name: string) => timestamp(name, { withTimezone: true });

export const roleEnum = pgEnum("credential_role", ["OWNER", "APPROVER", "AGENT"]);
export const jobStatusEnum = pgEnum("job_status", [
  "DRAFT",
  "PENDING_CHAIN",
  "ACTIVE",
  "PAUSED",
  "CLOSED",
]);
export const agentStatusEnum = pgEnum("agent_status", ["ACTIVE", "REVOKED"]);
export const payeeKindEnum = pgEnum("payee_kind", ["X402_ORIGIN", "ADDRESS"]);
export const decisionKindEnum = pgEnum("decision_kind", ["PURCHASE", "INVOICE"]);
export const decisionResultEnum = pgEnum("decision_result", [
  "ALLOWED",
  "DENIED",
  "NEEDS_APPROVAL",
]);
// Must match authorizationStates in @bursar/policy (asserted in test/schema.test.ts).
// Listed here because drizzle-kit loads this file without the workspace source condition.
export const authorizationStateEnum = pgEnum("authorization_state", [
  "PENDING_APPROVAL",
  "RESERVED",
  "RELEASING",
  "FUNDED_WALLET",
  "SIGNING",
  "UNRESOLVED",
  "SETTLED",
  "RELEASED",
  "REJECTED",
]);

export const owners = pgTable("owners", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  walletAddress: text("wallet_address"),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    title: text("title").notNull(),
    customer: text("customer").notNull(),
    status: jobStatusEnum("status").notNull().default("DRAFT"),
    budget: money("budget").notNull(),
    deposited: money("deposited")
      .notNull()
      .default(sql`0`),
    settled: money("settled")
      .notNull()
      .default(sql`0`),
    reserved: money("reserved")
      .notNull()
      .default(sql`0`),
    pending: money("pending")
      .notNull()
      .default(sql`0`),
    unresolved: money("unresolved")
      .notNull()
      .default(sql`0`),
    perTxCap: money("per_tx_cap").notNull(),
    approvalThreshold: money("approval_threshold").notNull(),
    windowCap: money("window_cap").notNull(),
    windowSeconds: integer("window_seconds").notNull().default(3600),
    windowStart: at("window_start").notNull().defaultNow(),
    windowSpent: money("window_spent")
      .notNull()
      .default(sql`0`),
    expiresAt: at("expires_at").notNull(),
    delegationAllowed: boolean("delegation_allowed").notNull().default(true),
    vaultJobId: text("vault_job_id"),
    /** The job's Circle developer-controlled wallet: receives top-ups, signs x402 payments. */
    agentWalletId: text("agent_wallet_id"),
    agentWalletAddress: text("agent_wallet_address"),
    /** JobVault's policyVersion as last seen by the indexer. 0 = not on-chain yet. */
    policyVersion: integer("policy_version").notNull().default(0),
    /**
     * Set when the vault paid out money Bursar has no record of (e.g. a leaked operator key used
     * outside Bursar). The job is paused off-chain at once and on-chain by the reconciler.
     */
    frozenReason: text("frozen_reason"),
    /** Circle transfer sweeping leftover dust out of the job wallet, while one is in flight. */
    sweepTransferId: text("sweep_transfer_id"),
    /** What the AI operator should do. Set: the worker runs it when the job goes live. */
    brief: text("brief"),
    /** When the operator was last started for this job (null: due to start). */
    operatorRunAt: at("operator_run_at"),
    /** Revenue the last run knew about; more revenue arriving starts another run. */
    operatorRevenueSeen: money("operator_revenue_seen")
      .notNull()
      .default(sql`0`),
    /** The agent automatic runs act as. Revoking it stops automatic runs. */
    autopilotAgentId: uuid("autopilot_agent_id"),
    /** The owner's wallet, from the vault's JobCreated event. Funding from anyone else is revenue. */
    ownerWallet: text("owner_wallet"),
    /** USDC customers paid into the job (vault deposits not from the owner). */
    revenueReceived: money("revenue_received")
      .notNull()
      .default(sql`0`),
    /** What the AI operator's model calls have cost this job, in micro-USD. */
    llmCostMicros: money("llm_cost_micros")
      .notNull()
      .default(sql`0`),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("jobs_owner_idx").on(t.ownerId),
    uniqueIndex("jobs_vault_job_idx").on(t.vaultJobId),
    check(
      "jobs_counters_non_negative",
      sql`${t.deposited} >= 0 AND ${t.settled} >= 0 AND ${t.reserved} >= 0 AND ${t.pending} >= 0 AND ${t.unresolved} >= 0 AND ${t.windowSpent} >= 0`,
    ),
    // The budget rule, enforced by Postgres as a backstop to the policy engine.
    check(
      "jobs_budget_invariant",
      sql`${t.settled} + ${t.reserved} + ${t.pending} + ${t.unresolved} <= ${t.budget}`,
    ),
    check(
      "jobs_limits_positive",
      sql`${t.budget} > 0 AND ${t.perTxCap} > 0 AND ${t.windowCap} > 0 AND ${t.windowSeconds} > 0 AND ${t.approvalThreshold} >= 0`,
    ),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    name: text("name").notNull(),
    role: text("role").notNull(),
    parentAgentId: uuid("parent_agent_id").references((): AnyPgColumn => agents.id),
    replacesAgentId: uuid("replaces_agent_id").references((): AnyPgColumn => agents.id),
    replacedByAgentId: uuid("replaced_by_agent_id").references((): AnyPgColumn => agents.id),
    status: agentStatusEnum("status").notNull().default("ACTIVE"),
    spendLimit: money("spend_limit"),
    committed: money("committed")
      .notNull()
      .default(sql`0`),
    createdAt: at("created_at").notNull().defaultNow(),
    revokedAt: at("revoked_at"),
  },
  (t) => [
    index("agents_job_idx").on(t.jobId),
    index("agents_parent_idx").on(t.parentAgentId),
    check(
      "agents_committed_within_limit",
      sql`${t.committed} >= 0 AND (${t.spendLimit} IS NULL OR ${t.committed} <= ${t.spendLimit})`,
    ),
  ],
);

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyHash: text("key_hash").notNull(),
    /** First characters of the key, for recognising it in the console. Never enough to use it. */
    keyPrefix: text("key_prefix").notNull(),
    role: roleEnum("role").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    jobId: uuid("job_id").references(() => jobs.id),
    agentId: uuid("agent_id").references(() => agents.id),
    approverId: uuid("approver_id").references((): AnyPgColumn => approvers.id),
    createdAt: at("created_at").notNull().defaultNow(),
    lastUsedAt: at("last_used_at"),
    revokedAt: at("revoked_at"),
    /** Wallet sign-in sessions expire; API keys (null) don't. */
    expiresAt: at("expires_at"),
  },
  (t) => [
    uniqueIndex("credentials_key_hash_idx").on(t.keyHash),
    check(
      "credentials_agent_scope",
      sql`(${t.role} = 'AGENT') = (${t.jobId} IS NOT NULL AND ${t.agentId} IS NOT NULL)`,
    ),
  ],
);

export const payees = pgTable(
  "payees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    kind: payeeKindEnum("kind").notNull(),
    /** Normalised: an origin like https://api.example.com, or a lowercase 0x address. */
    value: text("value").notNull(),
    label: text("label"),
    category: text("category"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("payees_job_value_idx").on(t.jobId, t.kind, t.value)],
);

export const categoryLimits = pgTable(
  "category_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    category: text("category").notNull(),
    spendLimit: money("spend_limit").notNull(),
    committed: money("committed")
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    uniqueIndex("category_limits_job_category_idx").on(t.jobId, t.category),
    check(
      "category_committed_within_limit",
      sql`${t.committed} >= 0 AND ${t.committed} <= ${t.spendLimit}`,
    ),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    operationId: text("operation_id").notNull(),
    kind: decisionKindEnum("kind").notNull(),
    payee: text("payee").notNull(),
    amount: money("amount").notNull(),
    category: text("category"),
    /** For invoices: the vendor's own reference (invoice number), shown in the evidence. */
    invoiceRef: text("invoice_ref"),
    reasoning: text("reasoning").notNull(),
    result: decisionResultEnum("result").notNull(),
    reason: text("reason"),
    checks: jsonb("checks").notNull(),
    remainingAtDecision: money("remaining_at_decision").notNull(),
    /** The on-chain rules version this decision was made under; releases cite it. */
    policyVersion: integer("policy_version"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    // One operation ID gets one decision, forever. Retries return the original.
    uniqueIndex("decisions_job_operation_idx").on(t.jobId, t.operationId),
    index("decisions_job_created_idx").on(t.jobId, t.createdAt),
  ],
);

export const authorizations = pgTable(
  "authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => decisions.id),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    amount: money("amount").notNull(),
    category: text("category"),
    state: authorizationStateEnum("state").notNull(),
    payer: text("payer"),
    payTo: text("pay_to"),
    paymentNonce: text("payment_nonce"),
    validBefore: at("valid_before"),
    /** keccak256 of the authorization id: the once-only operation ID used on-chain. */
    vaultOpId: text("vault_op_id"),
    vaultTx: text("vault_tx"),
    /** Nonce of the release transaction, so a stuck one is replaced at the same nonce. */
    vaultTxNonce: integer("vault_tx_nonce"),
    vaultTxSentAt: at("vault_tx_sent_at"),
    paymentTx: text("payment_tx"),
    /** Circle transaction moving unspent USDC from the job wallet back to the vault. */
    refundTransferId: text("refund_transfer_id"),
    /** JobVault.refund transaction crediting the job back. */
    refundTx: text("refund_tx"),
    /** The x402 resource being bought and the seller's payment requirements, from the quote. */
    paymentUrl: text("payment_url"),
    paymentRequirements: jsonb("payment_requirements"),
    /** The paid response body, capped in size, returned to the agent. */
    deliverable: text("deliverable"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: at("next_attempt_at"),
    lastError: text("last_error"),
    resolvedReason: text("resolved_reason"),
    createdAt: at("created_at").notNull().defaultNow(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("authorizations_decision_idx").on(t.decisionId),
    index("authorizations_job_state_idx").on(t.jobId, t.state),
    index("authorizations_work_idx").on(t.state, t.nextAttemptAt),
    check("authorizations_amount_positive", sql`${t.amount} > 0`),
  ],
);

/** Every chain log the indexer has applied. The unique key makes applying an event idempotent. */
export const chainEvents = pgTable(
  "chain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    eventName: text("event_name").notNull(),
    vaultJobId: text("vault_job_id"),
    appliedAt: at("applied_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("chain_events_tx_log_idx").on(t.txHash, t.logIndex)],
);

/** How far each indexer has read. */
export const chainCursors = pgTable("chain_cursors", {
  name: text("name").primaryKey(),
  block: bigint("block", { mode: "number" }).notNull(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

/**
 * A human who can approve payments above a job's threshold. Their wallet signs an EIP-712
 * approval that JobVault verifies itself; the owner must also allow the wallet on-chain.
 */
export const approvers = pgTable(
  "approvers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    name: text("name").notNull(),
    /** Lowercase 0x address. */
    walletAddress: text("wallet_address").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("approvers_owner_wallet_idx").on(t.ownerId, t.walletAddress)],
);

export const approvalVerdictEnum = pgEnum("approval_verdict", ["APPROVED", "REJECTED", "EXPIRED"]);

/** A human's verdict on one payment that needed approval. One per authorization. */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorizationId: uuid("authorization_id")
      .notNull()
      .references(() => authorizations.id),
    approverId: uuid("approver_id").references(() => approvers.id),
    verdict: approvalVerdictEnum("verdict").notNull(),
    /** The approver's wallet and EIP-712 signature, passed to JobVault.release as-is. */
    approverAddress: text("approver_address"),
    signature: text("signature"),
    /** Signature expiry, checked by JobVault against chain time. */
    deadline: at("deadline"),
    /** The policy version the approver signed over. */
    policyVersion: integer("policy_version"),
    note: text("note"),
    decidedAt: at("decided_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("approvals_authorization_idx").on(t.authorizationId)],
);

/** One run of the AI operator (or a sub-agent): what it cost and what it concluded. */
export const operatorRuns = pgTable(
  "operator_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    model: text("model").notNull(),
    brief: text("brief").notNull(),
    steps: integer("steps").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** Model spend in micro-USD (not USDC paid on-chain). */
    costMicros: money("cost_micros").notNull(),
    /** "completed" | "step_limit" | "refused" | "error" */
    outcome: text("outcome").notNull(),
    summary: text("summary"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [index("operator_runs_job_idx").on(t.jobId, t.createdAt)],
);

/**
 * A daily snapshot of the traction numbers, so there's history to chart and to quote in the
 * submission. Written by the worker; `scope` is "global" or an owner id.
 */
export const metricsDaily = pgTable(
  "metrics_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    day: text("day").notNull(),
    /** "testnet" or "mainnet". */
    network: text("network").notNull(),
    scope: text("scope").notNull(),
    data: jsonb("data").notNull(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("metrics_daily_day_network_scope_idx").on(t.day, t.network, t.scope)],
);

/**
 * The hash-chained audit log (G5). One chain for the whole deployment, append-only: each entry's
 * hash covers the previous entry's hash, so changing, deleting or reordering any entry breaks
 * every hash after it. The worker anchors the head on Arc (`audit_anchors`).
 */
export const auditChain = pgTable(
  "audit_chain",
  {
    /** Gapless, assigned under an advisory lock: 1, 2, 3, … */
    seq: bigint("seq", { mode: "number" }).primaryKey(),
    /** Whose entry this is; payloads are only ever shown to that job's owner. */
    jobId: uuid("job_id").references(() => jobs.id),
    /** "decision" or "transition". */
    event: text("event").notNull(),
    /** The decision or authorization the entry is about. */
    refId: uuid("ref_id").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_chain_job_idx").on(t.jobId, t.seq),
    index("audit_chain_ref_idx").on(t.refId),
  ],
);

export const anchorStatusEnum = pgEnum("anchor_status", ["SENT", "CONFIRMED", "FAILED"]);

/** Audit-chain heads posted to AuditAnchor on Arc. */
export const auditAnchors = pgTable(
  "audit_anchors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** AuditAnchor's own sequence number (1, 2, 3, … on-chain). */
    anchorSeq: integer("anchor_seq").notNull(),
    /** The last audit entry the anchored head covers. */
    chainSeq: bigint("chain_seq", { mode: "number" }).notNull(),
    head: text("head").notNull(),
    status: anchorStatusEnum("status").notNull(),
    txHash: text("tx_hash"),
    error: text("error"),
    sentAt: at("sent_at").notNull().defaultNow(),
    confirmedAt: at("confirmed_at"),
  },
  (t) => [
    uniqueIndex("audit_anchors_confirmed_seq_idx")
      .on(t.anchorSeq)
      .where(sql`${t.status} = 'CONFIRMED'`),
  ],
);

/** One-time nonces for Sign-In with Ethereum: each can sign in once, within a few minutes. */
export const siweNonces = pgTable("siwe_nonces", {
  nonce: text("nonce").primaryKey(),
  createdAt: at("created_at").notNull().defaultNow(),
  usedAt: at("used_at"),
});

export const alertTargetKindEnum = pgEnum("alert_target_kind", ["WEBHOOK", "TELEGRAM"]);

/** Where an owner's alerts go: a signed webhook, or a Telegram chat linked through the bot. */
export const alertTargets = pgTable(
  "alert_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    kind: alertTargetKindEnum("kind").notNull(),
    /** Webhooks: where to POST. */
    url: text("url"),
    /** Webhooks: the HMAC key the receiver verifies signatures with (shown to the owner once). */
    secret: text("secret"),
    /** Telegram: the linked chat. */
    chatId: text("chat_id"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("alert_targets_owner_idx").on(t.ownerId),
    uniqueIndex("alert_targets_owner_chat_idx").on(t.ownerId, t.chatId),
  ],
);

/**
 * The alert outbox. Each event is written once (`dedupeKey`), then delivered to every target with
 * retries, so a crash or a flaky receiver never loses or doubles an alert.
 */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    jobId: uuid("job_id").references(() => jobs.id),
    /** needs_approval | stuck_payment | budget_80 | job_frozen | denial_burst | test */
    type: text("type").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Where in the console to act on it. */
    link: text("link"),
    createdAt: at("created_at").notNull().defaultNow(),
    sentAt: at("sent_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: at("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    /** Gave up after too many failed deliveries. */
    failedAt: at("failed_at"),
  },
  (t) => [
    uniqueIndex("alerts_dedupe_idx").on(t.dedupeKey),
    index("alerts_pending_idx").on(t.sentAt, t.nextAttemptAt),
    index("alerts_owner_idx").on(t.ownerId, t.createdAt),
  ],
);

/** One-time codes that link a Telegram chat to an owner (t.me/<bot>?start=<code>). */
export const telegramLinks = pgTable("telegram_links", {
  code: text("code").primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => owners.id),
  createdAt: at("created_at").notNull().defaultNow(),
  usedAt: at("used_at"),
});
