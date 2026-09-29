# Bursar — Build Plan for the Tameion Agents Hackathon

> **Give an AI team a job and a budget, not the company wallet.**
> Bursar holds each job's USDC on Arc in a contract that enforces the budget. An AI operator decides what to spend it on, and every payment carries a reason, a policy decision and an Arc transaction. The agent cannot raise its own budget or pretend to be another agent, and even if our server is compromised the damage is capped by on-chain rules only the owner can change.

| | |
|---|---|
| Event | Tameion Agents Hackathon · Canteen × Circle · https://tameion.thecanteenapp.com/ |
| Window | Sun Sep 27 → Sat Oct 10, 2026 (online, 2 weeks, invite-only) |
| Deadline | **Oct 10, 11:59 PM ET** — submit a first version by **Oct 6**, resubmit freely afterwards |
| Settlement | Arc (Circle's stablecoin L1), USDC; testnet first, mainnet (chain ID 5042) for real customers |
| Primary RFB | **RFB 04 · Autonomous Business Operator** |
| Secondary RFBs | RFB 05 (audit trail / compliance), RFB 02 (invoice payments) |
| Status | Plan — nothing built yet |

Working name **Bursar** (a college's treasurer). Rename freely.

---

## Contents

1. [The problem](#1-the-problem)
2. [The product](#2-the-product)
3. [How we meet every Tameion requirement](#3-how-we-meet-every-tameion-requirement)
4. [Lessons taken from prior art (Reins)](#4-lessons-taken-from-prior-art-reins)
5. [Known gaps in prior art and how Bursar closes them](#5-known-gaps-in-prior-art-and-how-bursar-closes-them)
6. [Architecture](#6-architecture)
7. [Trust model and credentials](#7-trust-model-and-credentials)
8. [Components in detail](#8-components-in-detail)
9. [Circle and Arc tool usage](#9-circle-and-arc-tool-usage)
10. [Repository layout and stack](#10-repository-layout-and-stack)
11. [Testing strategy](#11-testing-strategy)
12. [Two-week schedule](#12-two-week-schedule)
13. [Traction plan](#13-traction-plan)
14. [Demo film](#14-demo-film)
15. [Submission checklist](#15-submission-checklist)
16. [Risks and mitigations](#16-risks-and-mitigations)
17. [After the hackathon](#17-after-the-hackathon)
18. [Reference links](#18-reference-links)

---

## 1. The problem

AI agents can already discover services and pay for them on their own (x402, agent wallets). Put **several agents on one job** and budget control becomes a distributed-systems problem:

> Three agents each check a 1.00 budget, each see enough, and each spend 0.40. Every decision was reasonable. Together they spent 1.20.

Checking the balance is not enough. The check and the spend have to be one atomic step, shared by every agent on the job — and the limit has to live somewhere the agent cannot reach.

Circle's Agent Wallets already give **per-wallet** spending policies. That does not solve this: three wallets each under their own cap can still overspend a job together, and an agent with access to the policy service can still ask for more. Bursar's unit is the **job**, not the wallet. It is a layer **on top of** Circle Agent Wallets, not a competitor.

---

## 2. The product

### 2.1 One-paragraph description

A business creates a **job** (a client project, a film, a research task) and funds it with USDC into an on-chain **JobVault** on Arc. It adds an **AI operator** and any sub-agents. Every agent spends only through Bursar: it asks to buy a service or pay an invoice, attaches its reasoning, and Bursar runs a fixed-order policy, reserves the exact amount atomically, and only then lets the job's Circle Agent Wallet sign. Anything above an approval threshold waits for a human. Every decision — allowed, denied or escalated — is written to a hash-chained log whose head is anchored on Arc.

### 2.2 The budget rule

```text
settled + reserved + pending_approval + unresolved  <=  job budget
```

Held **before** anything is signed, not after settlement. Enforced in three places:

1. Postgres, with a single conditional `UPDATE` (fast path) and a `CHECK` constraint (backstop).
2. The JobVault contract on Arc (hard limit, survives a compromised server).
3. The Circle Agent Wallet's own spending policy (second on-chain layer).

### 2.3 What makes it different

- **Shared job budgets** across agents, delegated children and replacements — none of them ever creates new money.
- **Three outcomes**, not two: allow, deny, or escalate to a human.
- **Idempotency enforced on-chain**: an operation ID can release money only once, even if our database is lost.
- **Reasoning stored beside the rule**: evidence shows *why the agent wanted it* and *which rule allowed it*.
- **Scoped credentials**: agents can spend, but cannot create jobs, raise budgets, un-revoke themselves or impersonate each other.
- **Tamper-evident audit log**: hash-chained decisions, head anchored on Arc.

---

## 3. How we meet every Tameion requirement

| Requirement / criterion | How Bursar meets it |
|---|---|
| Runs on Arc, USDC actually moving | JobVault on Arc; every budget and payment is USDC. Testnet from day 5, mainnet for willing users from day 11. |
| Built on the Circle Agent Stack | Agent Wallets, Circle CLI, x402 via Circle's hosted Facilitator, Paymaster, Gateway/Nanopayments; EURC as stretch |
| **30% Agentic sophistication** | An LLM operator that *chooses* what to buy or pay, compares price vs. value, delegates to sub-agents, reacts to denials, and escalates. Reasoning logged per decision. Not a script. |
| **30% Traction** | Real users from day 1 (§13). Metrics tracked in the product and exported for the submission. |
| **20% Circle tool usage** | ≥5 tools genuinely used (§9) |
| **20% Innovation** | Job-scoped budgets across agents, on-chain idempotency, reasoning-plus-rule evidence, hash-chained log anchored on Arc |
| RFB 04 "limits enforced in the contract rather than the prompt" | JobVault + scoped credentials + wallet policy |
| RFB 04 "decision log: what was done, why, what it cost" | `decisions` table + hash chain + evidence page |
| RFB 04 "escalate to a human only when a policy threshold is hit" | `PENDING_APPROVAL` state + approval inbox + alerts |
| RFB 04 "at least one complete workflow start to finish" | revenue in → liquidity check → buy/pay → record → escalate above threshold (§8.7) |
| Real business; no synthetic data | No demo-flagged jobs count toward metrics. Every job is owned by a real user. |
| Public GitHub repo | Required; evidence-first README |
| Demo video < 3 minutes | Required; made with our film pipeline (§14) |
| Live product link | Public landing page + **read-only demo job** judges can explore without keys, plus the operator console for real users (§8.9) |
| "Build for a reviewer who will click around without you" | Judge path: landing → demo job → evidence → Arc Explorer, no sign-up |
| Luma handles | GitHub and Discord handles on Luma must match the submission |
| Built from scratch | New code only. Prior art informs design; no code or assets copied. |

---

## 4. Lessons taken from prior art (Reins)

Reins (github.com/Enoch208/Reins, built for an OKX / X Layer event) proved the core idea. We are **unaffiliated** and write everything from scratch; these are the design lessons we keep.

| # | Lesson | How Bursar applies it |
|---|---|---|
| L1 | One budget rule, checked **before** authorization | §2.2, with `pending_approval` added |
| L2 | Reserve with one conditional statement — never read, check, then write | `UPDATE jobs SET reserved = reserved + $amt WHERE id = $job AND status='ACTIVE' AND settled + reserved + pending + unresolved + $amt <= budget RETURNING *` — zero rows means denied |
| L3 | Database `CHECK` constraint as a backstop | `jobs_budget_invariant` |
| L4 | Integer money only | micro-USDC as `bigint`. Arc detail: native USDC gas uses **18 decimals**, ERC-20 USDC uses **6**, and they are the *same balance*. One conversion module, tested at every boundary. |
| L5 | Fixed-order pure policy function; first failure is the reason | `packages/policy`, shared by API and contract tests |
| L6 | Operation-ID idempotency | unique `(job_id, operation_id)` in Postgres **and** `usedOp[jobId][opId]` in the contract |
| L7 | A timeout never frees budget | `UNRESOLVED` keeps its budget until chain proves the outcome |
| L8 | Persist payer, nonce and expiry **before** sending | written in the same transaction that moves the row to `SIGNING` |
| L9 | Delegation and replacement never create money | children and replacements draw on the job; optional sub-limits are carved *out of* the job budget |
| L10 | A denial is a recorded decision, not an authorization | `decisions` row with reason and remaining budget at that moment |
| L11 | Probe x402 first, reserve the exact quoted price | `quote()` step before policy |
| L12 | Test real parallelism against real Postgres | no mocked locks anywhere |
| L13 | Safe public defaults | bind to localhost unless `HOST` set; payee allow-list; credentials required |

---

## 5. Known gaps in prior art and how Bursar closes them

Reins' README admits two limits: X Layer/USDT0 only, and one operator key with no per-user roles. Reading its code surfaced more. Each one below is a design requirement for Bursar.

### 5.1 Trust and security (highest priority)

| # | Gap in prior art | Consequence | Bursar requirement | Day |
|---|---|---|---|---|
| G1 | Agents hold the same admin key as humans; one key guards every write route | An agent that can buy can also create a bigger job or un-revoke itself — the limit depends on the agent behaving | **Separate credentials**: owner, approver, agent. Agent keys can only call spend endpoints for their own job. (§7) | 3 |
| G2 | Agent identity is whatever `agentId` the request body says | A revoked agent can send a teammate's ID and keep spending | Agent identity is **derived from the credential**, never the body. Stretch: requests signed with the agent's own key. | 3 |
| G3 | Enforcement only in Postgres; one shared wallet holds all jobs' money | A compromised API or database means no limit at all | **JobVault contract** per job + Circle wallet policy as second layer | 4 |
| G4 | All GET requests are public | Jobs, customers, amounts and evidence visible to anyone | Reads require a credential, scoped to the owner's jobs; a separate opt-in **public evidence link** per decision for sharing | 5 |
| G5 | Evidence is ordinary database rows | The operator could quietly edit history | **Hash-chained decision log**; chain head anchored on Arc every N minutes | 8 |

### 5.2 Reliability

| # | Gap | Bursar requirement | Day |
|---|---|---|---|
| G6 | Reconciler scans a fixed 1,200-block window | A **stored scan checkpoint**; also index the vault's own `Released` events | 6 |
| G7 | Reconciler is a plain loop inside the API process, no lock | Postgres **advisory lock** so only one instance reconciles; safe to scale the API | 6 |

### 5.3 Product

| # | Gap | Bursar requirement | Day |
|---|---|---|---|
| G8 | Only allow or deny | **`PENDING_APPROVAL`** that holds budget; approval inbox; expiry → denied | 6 |
| G9 | No sub-budgets | Optional per-agent and per-category limits carved out of the job budget | 8 |
| G10 | Scripted agents, no reasoning | **LLM operator**; reasoning attached to every request | 7 |
| G11 | Purchases only | **Invoice / vendor payment** lane through the vault | 8 |
| G12 | Revenue is a number, never moves | Customers pay **into** the job on-chain; real profit per job | 7 |
| G14 | No alerts or integrations | Webhooks + Telegram alerts for escalations, denials, nearly-spent budgets; **MCP server** for any agent framework | 9–10 |
| G15 | Single chain, single token | Arc + USDC native; EURC stretch; Gateway for a unified balance | 11 |

**Pitch line derived from this section:** *"The agent can't raise its own budget, can't pretend to be another agent, and even if our server is compromised the damage is capped by on-chain rules only the owner can change."*

---

## 6. Architecture

```text
   Real user (business owner)                 Human approver
        │ owner key: create job, fund,               ▲ approver key:
        │ add agents, revoke                         │ approve / reject
        ▼                                            │
 ┌──────────────────────────── Bursar ────────────────────────────────┐
 │  Console (web)        API (Hono + zod)        Policy (pure fn)       │
 │  Postgres: jobs · agents · credentials · decisions · authorizations │
 │            approvals · audit_chain · metrics                         │
 │  Reconciler (advisory lock, checkpointed)   Anchor job (hash → Arc)  │
 │  Alerts (webhook / Telegram)                MCP server               │
 └───────▲───────────────────────┬──────────────────────┬──────────────┘
         │ agent key: spend      │ release (on-chain)   │ read receipts,
         │ + reasoning           ▼                      ▼ Released events
 ┌───────┴────────┐   ┌──────────────────────────────────────────────┐
 │ AI operator    │   │ Arc · JobVault (USDC)                         │
 │ (Claude API)   │   │ budget · per-tx cap · payee allow-list        │
 │ + sub-agents   │   │ opId once-only · revoke · expiry · threshold  │
 └───────┬────────┘   └──────────────────┬───────────────────────────┘
         │ x402 request                  │ exact top-up per payment
         ▼                               ▼
  Paid services  ◄───────────  Circle Agent Wallet (one per job) signs
  (Circle Facilitator on Arc)   own spending policy · Paymaster (no gas token)
```

**Who owns what**

| Layer | Owns |
|---|---|
| Bursar API | Policy, reservations, approvals, idempotency, reconciliation, evidence, metrics |
| JobVault (Arc) | Custody of job funds, hard budget, once-only operation IDs, payee allow-list |
| Circle Agent Wallet | Keys and signing; its own per-transaction policy. Bursar never stores a private key. |
| x402 + Circle Facilitator | Payment handshake with sellers |
| Arc | Settlement and receipts |
| AI operator | Deciding what is worth buying, and explaining why |

---

## 7. Trust model and credentials

### 7.1 Roles

| Role | Held by | Can | Cannot |
|---|---|---|---|
| **Owner** | The business | Create/close jobs, fund, set budgets and thresholds, add/revoke agents, issue agent keys, read everything for their jobs | — |
| **Approver** | A named human (can be the owner) | Approve or reject `PENDING_APPROVAL` decisions for jobs they're assigned | Change budgets, create jobs |
| **Agent** | One AI agent | Quote, request spend, pay invoice, spawn sub-agent (if job allows), read its own job's remaining budget | Create jobs, change limits, revoke/unrevoke, act as another agent, read other jobs |
| **Public viewer** | Anyone with a share link | View one decision's evidence page | Anything else |

### 7.2 Mechanics

- Keys are random 32-byte tokens; only a SHA-256 hash is stored. Shown once at creation.
- Every request resolves to `(role, owner_id, job_id?, agent_id?)` from the credential. **Request bodies never carry identity.**
- Revoking an agent revokes its key immediately and blocks its sub-agents' keys (off-chain: agents aren't on-chain identities, §8.1.1). "Revoke all" also calls `pause(jobId)` on the vault, so nothing can be released until the owner unpauses.
- Agent keys are scoped to exactly one job. A sub-agent gets its own key, issued by the API when the operator spawns it.
- Stretch (G2+): agents sign each request (Ed25519), so a leaked bearer token alone isn't enough.
- Timing-safe comparison on hashed keys. Rate limit per credential.

### 7.3 What a compromised component can do

| Compromised | Worst case | Why it's bounded |
|---|---|---|
| One agent | Spend up to its job's remaining budget, only to allow-listed payees, within per-tx cap | Vault + policy |
| Bursar API/database + operator key | Release, per job, up to the remaining budget — only to allow-listed payees or the job's agent wallet, within the per-tx cap and hourly window cap; cannot reuse an opId | Vault rules are on-chain and only the owner can change them; owner can `pause` instantly (§8.1.6) |
| Circle wallet | Spend what's been topped up for pending payments (exact amounts, swept back) | Just-in-time funding |

Budget increases, payee allow-list changes and threshold changes on the vault require the **owner's** signature, not the API's operator key.

---

## 8. Components in detail

### 8.1 Contracts (Solidity, Foundry)

Two small, **immutable** contracts (no proxies, no upgrade keys — a bug fix means a new deployment and a migration, which is honest and simple for a hackathon):

| Contract | Job | Why separate |
|---|---|---|
| `JobVault` | Custody of job funds, the budget, once-only operation IDs, payees, approvals, pause | Holds money; keep it minimal and heavily tested |
| `AuditAnchor` | Stores audit-log heads posted by Bursar | Holds no money; can be redeployed freely without touching funds |

Both deployed on Arc testnet first, then mainnet. Source verified on Arc Explorer. Addresses live in `packages/contract/deployments.json` per network.

#### 8.1.1 Roles on-chain

On-chain, **agents are not identities** — only Bursar's operator key calls `release`. Per-agent rules (who asked, revoking one agent, sub-limits) live off-chain in the policy engine. What the chain guarantees is the job-level envelope: nothing beyond the budget, rate limit, per-tx cap and payee list, ever, no matter who is compromised.

| On-chain role | Address | Can |
|---|---|---|
| Owner | Business wallet (EOA or smart account) | Create/close job, fund, raise/lower budget, add/remove payees and approvers, change caps/threshold, pause/unpause, withdraw after close or expiry |
| Approver(s) | Named wallets per job | Sign EIP-712 approvals for releases above threshold |
| Operator | Bursar's release key (one per network; Paymaster pays its gas) | `release`, `refund` bookkeeping, `pause` (emergency only — cannot unpause) |
| Anyone | — | `fund` (lets customers pay revenue straight into a job) |

#### 8.1.2 `JobVault` interface

```solidity
struct Job {
    address owner;
    address agentWallet;      // Circle Agent Wallet for this job (option A top-ups)
    uint128 budget;           // USDC base units, 6 decimals (ERC-20 interface)
    uint128 spent;            // released and not refunded
    uint128 deposited;        // total funded
    uint128 perTxCap;
    uint128 approvalThreshold;
    uint128 windowCap;        // max released per rolling window (rate limit)
    uint64  window;           // e.g. 1 hour
    uint64  windowStart;
    uint128 windowSpent;
    uint64  expiry;
    Status  status;           // Active, Paused, Closed
}

// lifecycle — owner
function createJob(bytes32 jobId, JobParams calldata p) external;          // msg.sender becomes owner
function fund(bytes32 jobId, uint256 amount) external;                     // anyone; transferFrom (approve first)
function fundWithPermit(bytes32 jobId, uint256 amount, uint256 deadline,
                        uint8 v, bytes32 r, bytes32 s) external;           // one-tx funding via EIP-2612
function setBudget(bytes32 jobId, uint128 newBudget) external;             // owner; cannot go below spent
function setLimits(bytes32 jobId, uint128 perTxCap, uint128 threshold,
                   uint128 windowCap, uint64 window) external;             // owner
function setPayee(bytes32 jobId, address payee, bool allowed) external;    // owner
function setApprover(bytes32 jobId, address approver, bool allowed) external; // owner
function pause(bytes32 jobId) external;                                    // owner or operator
function unpause(bytes32 jobId) external;                                  // owner only
function closeJob(bytes32 jobId) external;                                 // owner; returns unspent to owner
function withdrawExpired(bytes32 jobId) external;                          // owner, after expiry

// spending — operator
function release(bytes32 jobId, bytes32 opId, address to, uint128 amount,
                 Approval calldata approval) external;
function refund(bytes32 jobId, bytes32 opId, uint128 amount) external;     // see 8.1.4

event JobCreated(bytes32 indexed jobId, address indexed owner, JobParams p);
event Funded(bytes32 indexed jobId, address indexed from, uint256 amount);
event Released(bytes32 indexed jobId, bytes32 indexed opId, address indexed to, uint128 amount, bool approved);
event Refunded(bytes32 indexed jobId, bytes32 indexed opId, uint128 amount);
event LimitsChanged(bytes32 indexed jobId, uint128 perTxCap, uint128 threshold, uint128 windowCap, uint64 window);
event PayeeChanged(bytes32 indexed jobId, address payee, bool allowed);
event ApproverChanged(bytes32 indexed jobId, address approver, bool allowed);
event StatusChanged(bytes32 indexed jobId, Status status);
```

**`release` checks, in order** (each a custom error, mirrored by the policy engine):

1. `msg.sender == operator` → `NotOperator`
2. `status == Active` → `JobNotActive`
3. `block.timestamp < expiry` → `JobExpired`
4. `to` is an allowed payee **or** `to == agentWallet` → `PayeeNotAllowed`
5. `amount <= perTxCap` → `PerTxCapExceeded`
6. `spent + amount <= budget` and `spent + amount <= deposited` → `BudgetExceeded` / `Underfunded`
7. rolling window: `windowSpent + amount <= windowCap` → `RateLimited`
8. `!usedOp[jobId][opId]` → `OpAlreadyUsed` (**idempotency on-chain**)
9. if `amount > approvalThreshold`: valid EIP-712 `Approval{jobId, opId, to, amount, deadline}` signed by an allowed approver, `deadline` not passed → `ApprovalRequired` / `BadApproval`

Effects before interaction (checks-effects-interactions), `SafeERC20` transfers, `ReentrancyGuard` on every function that moves USDC.

#### 8.1.3 USDC on Arc — details to verify on day 2

- The vault uses the **ERC-20 interface** of USDC (6 decimals). Arc's native gas balance (18 decimals) is the same money; the vault never touches the native side.
- Confirm the USDC ERC-20 address on Arc testnet and mainnet from Arc docs, and whether it supports EIP-2612 `permit` (one-tx funding) and EIP-3009 (x402).
- Confirm Paymaster can sponsor the operator's `release` calls so the operator key holds no gas balance of its own.

#### 8.1.4 The x402 payer question and refunds (resolve on day 2)

x402 payments use an EIP-3009 signature from the payer, normally an ordinary wallet, not a contract.

- **Option A (default):** `release(to = agentWallet, amount = exact quote)` tops up the job's Circle Agent Wallet, which then signs the x402 payment. If the x402 payment **fails or its signature expires unused**, the wallet sends the USDC back to the vault and the operator calls `refund(jobId, opId, amount)`, which lowers `spent` (never more than was released for that opId, at most once per opId). Without `refund`, every failed purchase would permanently eat budget — a gap in the first draft.
  Blast radius: the agent wallet only ever holds money for payments in flight. The Circle wallet's own spending policy is set to the same per-tx cap as a second layer.
- **Option B:** if Arc's USDC accepts contract signatures (ERC-1271), the vault could be the x402 payer directly and `refund` becomes unnecessary for purchases. Adopt only if the spike proves it end to end.

Direct invoice/vendor payments go straight from `release` to the allow-listed payee in both options.

#### 8.1.5 `AuditAnchor`

```solidity
function anchor(bytes32 head, uint64 seq, uint64 decisions) external;   // operator only; seq strictly increasing
event Anchored(bytes32 head, uint64 seq, uint64 decisions, uint256 timestamp);
```

#### 8.1.6 What the contracts do not protect against (stated honestly)

If Bursar's operator key and Circle wallet access are both stolen, an attacker can still release, per job, up to the remaining budget — but **only** to allow-listed payees or the job's agent wallet, **only** within the per-tx cap and the hourly window cap, and the owner can `pause` instantly. That is the true claim for the README and film: *the damage is capped by rules only the owner can change* — not "impossible".

#### 8.1.7 Contract testing and tooling

- Foundry unit tests for every custom error and every event.
- Fuzz: random sequences of fund / release / refund / setBudget / pause.
- Invariants: `spent <= budget`; `spent <= deposited`; vault USDC balance == Σdeposited − Σreleased + Σrefunded − Σwithdrawn; an opId releases at most once and refunds at most once.
- EIP-712 tests: wrong signer, wrong amount, expired deadline, replay on another job or chain.
- Policy-parity vectors shared with `packages/policy`.
- `slither` in CI; `forge coverage` ≥ 95% lines for `JobVault`.
- Deploy with `forge script` per network; verify on Arc Explorer; write addresses to `deployments.json`.
- Mainnet only after testnet has run real jobs for ≥ 3 days, with small per-job budgets.

### 8.2 Policy engine (`packages/policy`, pure TypeScript)

Fixed order. The first failure is the denial reason.

| # | Check | Result |
|---|---|---|
| 1 | Job is active | `JOB_NOT_ACTIVE` |
| 2 | Job has not expired | `JOB_EXPIRED` |
| 3 | Agent belongs to the job (from credential) | `AGENT_NOT_IN_JOB` |
| 4 | Agent (and its parents) not revoked | `AGENT_REVOKED` |
| 5 | Payee/service on the job's allow-list | `PAYEE_NOT_ALLOWED` |
| 6 | Amount within per-transaction cap | `PER_TX_CAP_EXCEEDED` |
| 7 | Within agent sub-limit, if set | `AGENT_LIMIT_EXCEEDED` |
| 8 | Within category budget, if set | `CATEGORY_BUDGET_EXCEEDED` |
| 9 | Job budget capacity (atomic in DB) | `JOB_BUDGET_EXCEEDED` |
| 10 | Amount above approval threshold | → `NEEDS_APPROVAL` (not a denial) |

Identity checks moved earlier than in prior art: an impostor should learn nothing about budgets. The same table-driven cases run against the TypeScript engine and the Solidity contract (§11).

### 8.3 Decision and authorization states

```text
request ──► DENIED                       (a decision; no authorization row)
        ──► PENDING_APPROVAL ──approved──► RESERVED
                             ──rejected / expired──► DENIED (budget returned)
        ──► RESERVED ──► SIGNING ──► SETTLED
                     │           ├─► RELEASED     (definitive failure)
                     │           └─► UNRESOLVED   (outcome uncertain)
                     └─► RELEASED                  (failed before signing)
UNRESOLVED ──► SETTLED   (found on-chain)
           ──► RELEASED  (signature expired unused)
```

| State | Counts against budget as |
|---|---|
| PENDING_APPROVAL | `pending` |
| RESERVED, SIGNING | `reserved` |
| UNRESOLVED | `unresolved` |
| SETTLED | `settled` |
| RELEASED, DENIED | nothing |

Every legal transition is listed in one table; any other transition throws. Counter changes happen in the same database transaction as the state change.

The payment path splits `RESERVED` into finer on-chain steps (`RELEASING`, `FUNDED_WALLET`, `SIGNING`) — see §8.11.2. All of them count as `reserved`.

### 8.4 Data model (Postgres, Drizzle)

| Table | Key columns |
|---|---|
| `owners` | id, name, wallet_address, created_at |
| `credentials` | id, key_hash, role (`OWNER`/`APPROVER`/`AGENT`), owner_id, job_id?, agent_id?, revoked_at |
| `jobs` | id, owner_id, title, customer, budget, per_tx_cap, approval_threshold, expiry, status, vault_job_id, **settled, reserved, pending, unresolved** (all micro-USDC `bigint`), revenue_received; `CHECK (settled + reserved + pending + unresolved <= budget)` |
| `job_limits` | job_id, scope (`AGENT`/`CATEGORY`), key, limit, used |
| `payees` | job_id, kind (`X402_ORIGIN`/`ADDRESS`), value, label, category |
| `agents` | id, job_id, role, parent_agent_id, replaces_agent_id, wallet_id, status, revoked_at |
| `decisions` | id, job_id, agent_id, operation_id, kind (`PURCHASE`/`INVOICE`), payee, amount, category, **agent_reasoning**, result (`ALLOWED`/`DENIED`/`NEEDS_APPROVAL`), reason, remaining_at_decision, created_at; unique `(job_id, operation_id)` |
| `authorizations` | id, decision_id, state, payer, payee, nonce, valid_before, vault_tx, payment_tx, payment_block, resolved_reason, resolved_at |
| `approvals` | id, decision_id, approver_id, verdict, note, signature, expires_at, decided_at |
| `audit_chain` | seq, decision_id, event, payload_hash, prev_hash, hash, anchored_tx? |
| `reconcile_checkpoint` | chain_id, last_block |
| `alerts` | id, owner_id, channel, target, events[] |
| `metrics_daily` | date, owner_id, jobs, usdc_in, usdc_out, decisions, denials, escalations, human_agreed, unresolved_resolved, network (`testnet`/`mainnet`) |

### 8.5 API (Hono + zod)

| Method & path | Role | Purpose |
|---|---|---|
| `POST /jobs` | owner | Create job (DB + `createJob` on vault) |
| `POST /jobs/:id/fund-intent` | owner | Returns deposit instructions / payment link for customers |
| `POST /jobs/:id/payees` | owner | Allow-list a payee (DB + on-chain, owner-signed) |
| `POST /jobs/:id/agents` | owner | Add an agent, returns its key once |
| `POST /agents/:id/revoke` | owner | Revoke agent + children, freeze on-chain if last agent |
| `POST /spend/quote` | agent | Probe an x402 URL, return price and payee |
| `POST /spend/purchase` | agent | `{url, maxPrice, operationId, reasoning, category?}` |
| `POST /spend/invoice` | agent | `{payee, amount, invoiceRef, operationId, reasoning}` |
| `POST /spend/subagent` | agent | Spawn a child agent (if job allows), returns child key |
| `GET /spend/budget` | agent | Remaining capacity for its own job |
| `POST /approvals/:id` | approver | Approve (signs) or reject |
| `GET /jobs`, `/jobs/:id`, `/decisions`, `/metrics` | owner | Console data, scoped to owner |
| `GET /evidence/:shareToken` | public | One decision's evidence, opt-in share link |
| `POST /alerts` | owner | Register webhook / Telegram target |
| `POST /auth/wallet` | public | Sign-in with owner/approver wallet signature → short-lived session |
| `GET /stream/jobs/:id` | owner / demo | Server-Sent Events: new decisions, state changes, budget counters |
| `GET /metrics/public` | public | Aggregate numbers only (no customers, no amounts per job) for the landing page |
| `GET /demo/*` | demo read credential | Read-only mirror of the demo owner's job routes, used by `/demo` (held server-side by the web app, never shipped to the browser as a writable key) |

Every write goes through one service function per operation, wrapped in a single transaction. Errors are typed (`{error, message}`), never raw stack traces.

### 8.6 Payment executor and reconciler

**Purchase path (option A):**

1. `quote(url)` — request without payment, parse x402 `PAYMENT-REQUIRED` (network must be Arc, asset USDC, amount ≤ maxPrice, payTo allow-listed).
2. Policy + atomic reserve (or `PENDING_APPROVAL`).
3. Append decision to audit chain.
4. `vault.release(jobId, opId, agentWallet, amount)` — wait for receipt.
5. Circle Agent Wallet signs the x402 payload. Persist payer, nonce, validBefore → state `SIGNING`.
6. Replay request with payment. On a clear success → verify the USDC transfer on Arc → `SETTLED`. On a clear failure → `RELEASED` (sweep top-up back). On timeout / dropped response → `UNRESOLVED`.

**Reconciler** (every 15s, under `pg_try_advisory_lock`):

1. Adopt stale `SIGNING` rows past `validBefore + grace` as `UNRESOLVED`.
2. For each `UNRESOLVED`: receipt confirms transfer → `SETTLED`; USDC reports nonce used → `SETTLED` (find tx via indexed logs from checkpoint); `validBefore` passed and nonce unused → `RELEASED` + sweep.
3. Index `Released` events from `reconcile_checkpoint.last_block`; flag any on-chain release with no matching decision (should never happen → alert).
4. Advance checkpoint.

**Anchor job** (every 10 minutes, or every 50 decisions): post the latest `audit_chain.hash` via `vault.anchor(head, seq)`. The evidence page shows "this decision is covered by anchor #N, tx 0x…".

### 8.7 The AI operator (Claude API, tool use)

Default model: `claude-sonnet-5` for cost, `claude-opus-5-5` for hard decisions (configurable).

**Tools exposed to the model** (all go through the agent's own credential):

| Tool | Does |
|---|---|
| `get_budget()` | Remaining capacity, limits, threshold, obligations due |
| `list_services(category)` | Allow-listed x402 services with last known price and quality notes |
| `quote(url)` | Real price before committing |
| `purchase(url, maxPrice, reasoning)` | Spend request |
| `pay_invoice(payee, amount, ref, reasoning)` | Invoice payment |
| `spawn_subagent(role, limit, brief)` | Delegate with a carved-out limit |
| `request_approval(reasoning)` | Explicit escalation |
| `report(summary)` | Final job report written to the log |

**What it decides:**

- **Worth it?** Price vs. job value ("job pays $5.00; this dataset is $0.40 and removes the need for two other calls — buy").
- **Which seller?** Compare quotes across equivalent services.
- **How to split work?** Spawn sub-agents with explicit sub-limits.
- **What after a denial?** Cheaper alternative, request approval, or stop and report — and say which and why.
- **Pay now or later?** For invoices: due dates vs. liquidity.

**Guardrails:** the operator's system prompt is *not* the security boundary — credentials, policy and vault are. The prompt only shapes judgement. Each tool result includes the decision ID so the reasoning and the rule are linked in evidence.

**The complete RFB 4 workflow we demonstrate:**

1. Customer pays $5 USDC into the job (vault `fund`) → revenue recorded.
2. Operator checks liquidity and upcoming obligations.
3. Operator buys data/compute services via x402; spawns a sub-agent for part of the work.
4. A sub-agent's third concurrent purchase is denied before signing (`JOB_BUDGET_EXCEEDED`).
5. Operator tries to pay a $3 contractor invoice → above threshold → `PENDING_APPROVAL` → Telegram alert → human approves → paid.
6. Every decision, reason and tx lands in the chained log; head anchored on Arc.
7. Job closes; unspent USDC returns to the owner; profit shown.

### 8.8 Paid services (seller side)

- Run 1–2 of our own x402 services behind **Circle's hosted Facilitator** on Arc — e.g. a market-data endpoint and a text-to-speech / render endpoint used by our film pipeline.
- Integrate at least one **outside** service from Circle's Agent Marketplace so we're not only paying ourselves.

### 8.9 Frontend (`apps/web`)

One web app with three surfaces: a **public landing page**, a **public read-only demo job**, and the **authenticated operator console**. Judging is asynchronous and judges "click around without you in the room", so the first two exist for them; the console exists for real users.

#### 8.9.1 Routes

| Route | Access | Purpose |
|---|---|---|
| `/` | public | Landing page (§8.9.2) |
| `/demo` | public, read-only | A real, pre-loaded testnet job judges can explore without keys (§8.9.3) |
| `/e/:shareToken` | public | One decision's evidence page, opt-in share link |
| `/login` | public | Sign in: connect owner wallet (SIWE-style signature) or paste an owner/approver key |
| `/app/jobs` | owner | All jobs |
| `/app/jobs/new` | owner | Create + fund a job (wizard) |
| `/app/jobs/:id` | owner | Job page (the main screen) |
| `/app/approvals` | approver / owner | Approvals inbox — **must work on a phone** |
| `/app/decisions/:id` | owner | Evidence page (private view, "Create share link" button) |
| `/app/metrics` | owner | Traction numbers |
| `/app/settings` | owner | Keys, alerts, wallet |
| `/docs/quickstart` | public | "Protect your agent in 5 minutes" (MCP + API) — doubles as traction funnel |

#### 8.9.2 Landing page (`/`)

Goal: a judge understands the product in 10 seconds and reaches real evidence in two clicks.

1. **Hero:** "Give an AI team a job and a budget, not the company wallet." Sub-line: "Shared, on-chain spending limits for AI agents on Arc." Buttons: **Try the live demo** (→ `/demo`), **Read the quickstart**, **GitHub**.
2. **The problem, animated (≈10 s, CSS/SVG, no video):** three agents each check a $1.00 budget, each spend $0.40, the bar overflows to $1.20 in red. Then replays with Bursar: the third request is stopped with `JOB_BUDGET_EXCEEDED` and the bar stops at $0.80.
3. **Three layers of limits:** database reservation → JobVault contract on Arc → Circle wallet policy. One line each.
4. **"Can't be talked past":** three short claims with proof links: the agent can't raise its own budget · can't pretend to be another agent · even if our server is compromised, damage is capped by on-chain rules only the owner can change.
5. **Live numbers** (from `/metrics`, public aggregate only): businesses onboarded, USDC moved, overspends blocked, decisions anchored on Arc. Testnet and mainnet shown separately.
6. **How a payment works:** a 6-step strip (quote → policy → reserve → vault release → wallet signs → settled + logged).
7. **Built on:** Arc · USDC · Circle Agent Wallets · x402 · Paymaster · Gateway (logos only where brand rules allow; plain text otherwise).
8. **Footer:** Tameion Agents Hackathon 2026 · GitHub · demo video · contact.

No sign-up wall. No cookie banner needed (no tracking beyond privacy-friendly aggregate analytics, if any).

#### 8.9.3 Public demo job (`/demo`)

- A **real** job on Arc testnet run by our own film pipeline (our own business — not synthetic data), with real transactions, denials, one approval and one anchor.
- Same UI as the job page, rendered read-only: buttons show "Sign in to act" tooltips instead of acting.
- Refreshed by a scheduled run (e.g. every few hours a new film job runs), so the feed looks alive and every transaction links to Arc Explorer.
- Served by a dedicated **demo read credential** held by the web server — the API still never allows unauthenticated reads (G4 stays closed). The demo credential can read exactly one owner's jobs and nothing else.
- A banner: "This is a real job on Arc testnet run by Bursar's own film pipeline. Every link opens the chain."

#### 8.9.4 Operator console pages

| Page | Contents |
|---|---|
| **Jobs** | One card per job: title, customer, budget bar, revenue vs. spend, status, agent count, pending approvals badge. Filter: active / closed. "New job" button. |
| **New job wizard** | 1) title, customer, budget, per-tx cap, approval threshold, expiry · 2) payees (x402 origins or addresses, with categories) · 3) optional sub-limits · 4) sign `createJob` + `fund` with owner wallet · 5) create agent keys (shown once, copy buttons, MCP config snippet) |
| **Job page** (main screen) | Header (title, customer paid, expiry, agent count, **Revoke all**) · 4 metric tiles (budget, remaining, overspends blocked, profit so far) · **budget bar** (settled / reserved / awaiting approval / unresolved / remaining, with legend) · **decision feed** (agent → payee, amount, result pill, agent reasoning in quotes, rule + tx line) · **approval card** (if any) · **agent tree** (parents, children, replacements, sub-limits, revoke per agent) · "log anchored on Arc · #N · time" |
| **Approvals inbox** | Pending items: amount, payee, job, agent's case, policy context (remaining budget, threshold), expiry countdown. **Approve and sign** (owner/approver wallet signature, required by the vault) / **Reject** with note. Phone-first layout; Telegram alerts deep-link here. |
| **Evidence** | Vertical timeline for one decision: request → agent reasoning → each policy check (pass/fail) → reservation → vault `release` tx → x402 payment tx → settlement check → audit-chain position → anchor tx. Every tx links to Arc Explorer. "Verify chain" button recomputes hashes client-side against the anchored head. "Create share link". |
| **Metrics** | The §13.3 numbers as tiles + one line chart per metric over the event window; testnet vs. mainnet split; "Export CSV" for the submission form. |
| **Settings** | Owner wallet · approvers · agent keys (create, revoke, last used) · alert targets (webhook URL + secret, Telegram) · danger zone (close job, withdraw unspent). |

#### 8.9.5 Live updates and states

- Decision feed and budget bar update live via **Server-Sent Events** (`GET /stream/jobs/:id`), falling back to 5 s polling.
- Every list has an empty state that invites the next action ("Create your first job"), a loading skeleton, and a plain error message with a retry.
- Money always shown as USDC with 2 decimals (4 for sub-cent nanopayments); one USDC balance, never native and ERC-20 as two rows.
- Pending chain actions show a spinner with the tx hash as soon as it exists.

#### 8.9.6 Look and feel

- Calm finance-tool look: white/neutral surfaces, one accent colour, hairline borders, generous spacing. The **budget bar is the hero element** everywhere.
- Status colours carry meaning only: green settled, purple reserved, amber awaiting approval, coral unresolved, red denied.
- A light Tameion nod: a seal mark for the Bursar logo; "anchored" badges styled like a wax seal; serif (voice) font only for the agent's quoted reasoning, sans for everything else — so it's visually clear when *the agent* is talking.
- Light and dark mode. Desktop first; Approvals, Evidence and the landing page must also work at phone width.
- Accessibility: keyboard reachable, visible focus, colour never the only signal (pills carry text), sufficient contrast.

#### 8.9.7 Frontend stack

Vite · React · TypeScript · Tailwind · TanStack Query (data) · wagmi + viem with `arc` / `arcTestnet` chains (owner wallet signing) · a small SVG/CSS animation for the landing page (no heavy 3D) · shared zod types from `packages/contract`.

### 8.10 Alerts and integrations

- **Webhooks** (signed with HMAC) and **Telegram** for: `NEEDS_APPROVAL`, denial bursts, budget ≥ 80% used, unresolved > 5 minutes, unmatched on-chain release.
- **MCP server** (`apps/mcp`): exposes the agent tools so any Claude Code / Cursor / custom agent can use Bursar as its spending layer with just an agent key. This is our fastest route to other teams' traction.

### 8.11 Backend internals

The first draft described the backend's *features*. This section pins down *how* it runs, where the hard parts are.

#### 8.11.1 Processes

| Process | Runs | Scales |
|---|---|---|
| `api` | Hono HTTP + SSE | Horizontally (stateless) |
| `worker` | Background jobs via **pg-boss** (Postgres-backed queue — no Redis): tx sender, chain indexer, reconciler, anchor, alerts, sweeper, metrics rollup, demo-job scheduler | One instance; each job type also takes an advisory lock |
| `operator` | The AI operator runtime (§8.11.6) | One per active job, started by the worker |
| `seller` | Our x402 services | Independent |

#### 8.11.2 Keeping Postgres and the chain in agreement

Every payment touches both the database and Arc, and either can fail between steps. Rules:

1. **The database decides first, the chain enforces second.** A reservation commits in Postgres before any chain call.
2. **Every chain call is idempotent by `opId`.** `release` with a used opId reverts with `OpAlreadyUsed`, which the sender treats as "already done" and moves on. So retrying after a crash is always safe.
3. **Outbox pattern.** The reservation transaction also inserts a row into `chain_outbox` (`kind, job_id, op_id, payload, status`). The tx sender reads the outbox; nothing calls the chain directly from a request handler.
4. **Finer payment states:**

```text
RESERVED ─► RELEASING (vault tx sent) ─► FUNDED_WALLET (Released event seen)
         ─► SIGNING (x402 signed, nonce saved) ─► SETTLED
any step ─► RELEASED (definitive failure; refund if the vault already paid out)
SIGNING  ─► UNRESOLVED ─► SETTLED | RELEASED (+ refund)
```

5. **The indexer is the source of truth for on-chain facts.** It reads `JobCreated`, `Funded`, `Released`, `Refunded`, `StatusChanged` and `Anchored` from a stored checkpoint, and moves rows forward. A `Released` event with no matching reservation raises a critical alert and pauses the job.
6. **Jobs are created by the owner's wallet in the browser**, so a job goes `DRAFT` (DB row) → `PENDING_CHAIN` (tx sent) → `ACTIVE` when the indexer sees `JobCreated` and `Funded`. Revenue is recorded from `Funded` events, not from API calls.

#### 8.11.3 Transaction sender

- One operator key sends many transactions, so **nonces collide** under concurrency (exactly the race demo). A single sender worker owns the key and a **nonce manager**: it assigns nonces in order, tracks pending txs, and bumps fees on stuck ones.
- Batches are not needed at Arc's speed; ordering and retries are.
- Gas is sponsored through **Paymaster**; if sponsorship fails, the sender alerts instead of silently holding up payments.
- Receipts are awaited with a timeout; a timeout leaves the row in `RELEASING` for the indexer to settle.

#### 8.11.4 Circle wallet integration

- One Circle **developer-controlled / agent wallet per job**, created when the job is created and recorded as `agentWallet` on-chain.
- Circle entity secret and API key only in the `worker` environment, never in `api`.
- Signing x402 (EIP-3009 typed data) through Circle's signing API — **verify on day 2** that the typed-data signing path works on Arc testnet.
- Wallet spending policy set per job to the job's per-tx cap.
- **Sweeper:** any balance left in an agent wallet with no payment in flight goes back to the vault, followed by `refund` for its opId.

#### 8.11.5 Auth, sessions and API hygiene

- Owner/approver sign in with a wallet signature (SIWE-style) → short-lived session cookie (`HttpOnly`, `SameSite=Strict`) + CSRF token for writes. Agents use bearer keys (§7).
- Idempotency keys on **every** write, not only spends (creating a job twice by double-click must be harmless).
- Input validation with zod on every route; typed errors; no stack traces returned.
- Rate limits per credential and per IP; stricter on `quote` (it makes outbound requests).
- **SSRF guard** on `quote`/`purchase`: URL origin must be on the job's payee list before any request; resolve DNS once, refuse private/link-local IPs, pin the resolved IP, cap response size and time.
- CORS limited to our web origin.

#### 8.11.6 AI operator runtime

- Started by the worker when a job becomes `ACTIVE` (and on schedule for recurring jobs). Runs a tool-use loop with a **max step count** and **max wall time** per run.
- Model calls cost money too: the operator's own LLM spend is tracked per job and shown in profit. (Paying for the LLM via x402 through Bursar itself is a stretch goal.)
- **Prompt injection is expected.** Data returned by paid services, invoices and emails is untrusted; tool results are wrapped and labelled as data. It can't do real harm because payees are allow-listed, amounts are capped and the vault enforces both — the prompt is never the security boundary.
- Every tool call is logged with the model's reasoning, token usage and the decision ID it produced.
- Kill switch: revoking the operator's agent key stops the loop at its next tool call.

#### 8.11.7 Observability and operations

- Structured JSON logs with `request_id`, `job_id`, `decision_id`, `op_id`, `tx_hash` on every line.
- Error tracking (Sentry or similar) for `api`, `worker`, `web`.
- Health endpoints: `/health` (process), `/ready` (DB + RPC + Circle reachable), plus a worker heartbeat table.
- Critical alerts (to us): unmatched `Released` event, sender stuck > 2 minutes, indexer lag > 50 blocks, unresolved > 10 minutes, Paymaster failures.
- Config: one validated env schema per process; `NETWORK=testnet|mainnet` selects chain, USDC address and deployments.
- Database: Drizzle migrations in CI; daily backups from the managed Postgres provider; seed script for local dev only (never for metrics).
- Privacy: invoice files and customer names are the business's data — stored encrypted at rest, never shown on public pages; the public demo uses only our own business's data.

#### 8.11.8 Extra tables

| Table | Purpose |
|---|---|
| `chain_outbox` | Pending chain calls (kind, job_id, op_id, payload, status, tx_hash, attempts, next_attempt_at) |
| `chain_cursor` | Indexer checkpoint per contract |
| `sender_nonce` | Nonce manager state for the operator key |
| `sessions` | Owner/approver sessions |
| `idempotency_keys` | Stored responses for write requests |
| `operator_runs` | AI operator runs: job, steps, tokens, cost, outcome |
| `worker_heartbeat` | Liveness of each worker job type |

---

## 9. Circle and Arc tool usage

| Tool | Use in Bursar | Priority |
|---|---|---|
| USDC on Arc | Every budget, payment, revenue | Must |
| Circle Agent Wallets + CLI | One wallet per job; its own spending policy as a second limit | Must |
| x402 + Circle Facilitator | Buying services; running our own sellers | Must |
| Contracts (JobVault) | On-chain enforcement, idempotency, audit anchors | Must |
| Paymaster | Agents and vault calls never need a separate gas token | Should |
| Gateway / Nanopayments | Sub-cent per-call payments; unified balance view | Should |
| EURC | Paying an EU vendor in euros | Stretch |
| CCTP | Funding a job from USDC on another chain | Stretch |

Arc facts to remember: chain ID **5042** (mainnet); `viem/chains` ships `arc` and `arcTestnet`; RPC `https://rpc.mainnet.arc.io` / `https://rpc.testnet.arc.io`; native USDC (18 decimals) and ERC-20 USDC (6 decimals) are **one balance** — never show them as two.

---

## 10. Repository layout and stack

```text
bursar/
├─ packages/
│  ├─ money/        integer micro-USDC, 6↔18 decimal conversion (one place)
│  ├─ policy/       pure policy engine + shared test vectors
│  └─ contract/     shared API types (zod schemas)
├─ contracts/       Foundry: JobVault.sol, tests, deploy scripts
├─ apps/
│  ├─ api/          Hono, Drizzle, Postgres: HTTP + SSE, policy, reservations, approvals
│  ├─ worker/       pg-boss jobs: outbox tx sender, chain indexer, reconciler, sweeper, anchor, alerts, metrics
│  ├─ operator/     Claude tool-use operator + sub-agents + scenario runner
│  ├─ mcp/          MCP server wrapping the agent tools
│  ├─ seller/       our x402 services behind Circle's Facilitator
│  └─ web/          landing page, public demo job, operator console (Vite, React, Tailwind)
├─ docs/            architecture, trust model, runbook, traction log
└─ .github/workflows/ci.yml   lint · typecheck · test (with Postgres) · forge test
```

**Stack:** TypeScript (strict) · Node 22+ · pnpm · Hono · zod · Drizzle · Postgres · Vitest · viem · Foundry · Circle CLI / Agent Wallets SDK · x402 · Anthropic SDK · React · Tailwind.

**Hosting:** API + reconciler on Railway/Fly; Postgres on Neon/Supabase; console on Vercel/Cloudflare Pages.

**Secrets:** `.env.example` in every app; nothing secret committed; CI runs without secrets (chain tests use a local Anvil fork or fakes).

---

## 11. Testing strategy

| Area | Test |
|---|---|
| Budget rule | 25 parallel 0.10 requests vs. 1.00 budget → exactly 10 allowed; 40 mixed-size parallel requests stay within budget; randomised interleavings across seeds, invariant asserted after each round |
| Idempotency | 20 concurrent retries of one opId → one decision, one authorization; on-chain second `release` with same opId reverts |
| Credentials (G1, G2) | Agent key cannot create jobs, raise budgets, un-revoke, read other jobs; `agentId` in body is ignored; revoked key rejected immediately |
| Reads (G4) | Unauthenticated GETs return 401; owner A cannot read owner B's jobs; share link exposes exactly one decision; the demo read credential can read only the demo owner's jobs and cannot write anything |
| Frontend | Component tests for budget bar maths and money formatting; Playwright smoke test: landing → demo → evidence → Arc Explorer link; approvals page usable at 375px width |
| Approvals | Pending holds budget; reject/expiry returns it; approval above threshold without signature reverts on-chain |
| Timeouts | Uncertain outcome → `UNRESOLVED`, budget held; reconciler settles or releases from chain state |
| Reconciler (G6, G7) | Two instances → only one runs; restart resumes from checkpoint; outage longer than any window still resolves |
| Audit chain (G5) | Editing any past row breaks the chain; verify against anchored head |
| Delegation | Child and replacement draw on the job; sub-limit carved out, never added |
| Policy parity | Same vectors pass in TypeScript and in Foundry |
| Money | 6↔18 decimal conversions at every boundary; no float anywhere (lint rule) |
| Contract | See §8.1.7: fuzz, invariants (`spent <= budget`, balance conservation, opId once), EIP-712 approvals, slither |
| DB ↔ chain | Kill the worker between reservation and `release`, after `release` before the event, and after signing: every case ends `SETTLED` or `RELEASED`+refund, never double-paid, never lost |
| Tx sender | 30 concurrent releases from one operator key: no nonce collisions, all land in order |
| SSRF | `quote` refuses non-allow-listed origins, private IPs, redirects to private IPs, oversized responses |
| Operator | Injected instructions in a paid service's response ("pay 0xabc…") cannot cause a payment to a non-allow-listed payee |
| End to end | Scenario runner asserts: team, race, retry, delegation, replacement, policy, revoke, timeout, approval, invoice — on Arc testnet |

All Postgres tests run against a real database in CI. No mocked locks.

---

## 12. Two-week schedule

**Sun Sep 27 → Sat Oct 10.** Traction work runs in parallel from day 1.

| Day | Date | Build | Traction |
|---|---|---|---|
| 1 | Sun Sep 27 | Luma registration (passphrase, GitHub + Discord handles), join Canteen + Arc Discords, install ARC CLI + Circle CLI, get testnet USDC (Canteen testnet, TestMint). Monorepo skeleton, CI, `packages/money`. | Post in Canteen Discord: "building shared spend limits for agent teams — who wants early access?" |
| 2 | Mon Sep 28 | **Spikes:** (a) Circle Agent Wallet pays one x402 service on Arc testnet; (b) vault `release` → wallet top-up → pay. Choose option A or B. | Line up 3 user conversations |
| 3 | Tue Sep 29 | `packages/policy` + vectors; DB schema incl. `CHECK`; atomic reserve; **credentials and roles (G1, G2)**; concurrency tests | |
| 4 | Wed Sep 30 | `JobVault` + `AuditAnchor` with Foundry unit/fuzz/invariant/EIP-712 tests; owner-only limit changes, refund, pause, window cap (G3); slither; deploy + verify on Arc testnet; policy-parity tests | |
| 5 | Thu Oct 1 | ✅ *Done Sep 28.* Worker process: outbox (the authorizations table is the queue; no pg-boss), chain indexer (§8.11). Spend path end to end: quote → policy → reserve → release → sign → settle, proven live on Arc testnet; idempotency; SSRF guard; **scoped reads (G4)**. *Moved:* tx-sender hardening → day 6; web skeleton → day 9. | First user onboarded on testnet |
| 6 | Fri Oct 2 | ✅ *Done Sep 28, incl. sweeper, crash-after-signing test and unexplained-payout freeze.* Reconciler with **advisory lock + checkpoint (G6, G7)**; `UNRESOLVED`; sweeper + `refund`; crash-recovery tests; **`PENDING_APPROVAL` + EIP-712 approver signatures (G8)**. *From day 5:* tx-sender hardening (stuck-release fee bump, alert when a release is stuck > 2 min) and worker tests against a fake chain. | |
| 7 | Sat Oct 3 | ✅ *Done Sep 28. Gemini 3.1 Flash-Lite is the default, with 3.5 Flash-Lite as a daily-quota fallback, chosen by [eval](docs/evals/operator-models.md); Claude is supported. Also built: `metrics_daily`, a wall-clock limit, a kill switch, and seller catalogs. A live run with a helper and an approval settled on Arc. The operator is still started by hand (auto-start is day 9).* **AI operator v1 (G10)**: tools, reasoning log, full RFB 4 loop; **customer revenue into the job (G12)** | Second user; start `metrics_daily` |
| 8 | Sun Oct 4 | ✅ *Done Sep 28. Sub-limits now cover a helper's whole tree, replacements inherit only what was left, invoices are paid straight from the vault (live, with approval), and the log is anchored on Arc (2 anchors live). The console's Verify chain button is day 9.* Sub-agents, replacements, **sub-limits (G9)**; revoke cascade; **invoice lane (G11)**; **hash-chained log + anchor job (G5)** | |
| 9 | Mon Oct 5 | ✅ *Done Sep 28. Built on Vite + React with wallet sign-in (SIWE and WalletConnect), live updates, and the Graphite and gold design ([DESIGN.md](docs/DESIGN.md)). The wizard went live on Arc from the owner's wallet. Alerts use webhooks and Telegram through an outbox. The operator now starts automatically, with per-run keys and retries.* *From day 5:* web skeleton (routing, sign-in, jobs list, budget bar component). Console: job page (feed via SSE, agent tree), new-job wizard, approvals inbox (phone-first), evidence page, metrics; **alerts (G14)** | Users run real jobs |
| 10 | Tue Oct 6 | ✅ *Done Sep 29. Live at bursarhq.vercel.app (Vercel), API and worker on Render in one process, Neon, the seller at scenestock.vercel.app, and a production AuditAnchor. The public demo job runs itself on Arc; `bursar-mcp` 0.1.1 is on npm; `/docs` has 20 pages with search and llms.txt; README v1 is evidence-first ([notes](docs/spikes/day-10-launch.md)).* **Landing page** + **public demo job** (demo read credential, scheduled film-pipeline job); deploy API + DB + web; **MCP server (G14)**; quickstart page; README v1. **First submission.** | 3+ users; share MCP setup guide with other Tameion teams |
| 11 | Wed Oct 7 | ✅ *Done Sep 29. Nanopayments through Circle Gateway, live in production: the AI operator bought 0.001 items from a vault-funded float, each a gasless signature under the same rules and budget; closed jobs return their unspent float to the owner. Paymaster isn't available on Arc and isn't needed (gas is USDC). Mainnet deferred ([notes](docs/spikes/day-11-nanopayments.md)).* Paymaster; Gateway/Nanopayments; **mainnet** for willing users (G15) | First mainnet payments |
| 12 | Thu Oct 8 | ✅ *Security pass done Sep 29: API rate limits (per key, per address, spend calls, bad keys); the SSRF guard now blocks internal addresses however they're spelled (IPv4-in-IPv6, NAT64) and checks again at connection time (DNS rebinding); the RPC token is redacted from logs and stored errors; git history scanned clean. Landing animation, "Verify chain" and dark mode were already built. Deferred: metrics snapshot export → day 13; EURC skipped. Focus moves to hands-on testing and traction.* Stretch: EURC. Security pass (credential leaks, SSRF on quote URLs, rate limits). Landing animation, "Verify chain" button, dark mode polish. | Metrics snapshot |
| 13 | Fri Oct 9 | README final (evidence first); record footage; build demo film. *From day 12:* metrics snapshot export for the submission. | Collect user quotes |
| 14 | Sat Oct 10 | Final film, final submission **well before 11:59 PM ET** | |

> Note: Oct 10 is the deadline day in the event listing. Keep day 14 for polish only — everything required is in by the day-10 submission.

**Cut-line if time runs short** (drop in this order): EURC/CCTP → landing animation (keep a static diagram) → "Verify chain" button → Telegram (keep webhooks) → MCP server → sub-limits.
**Never cut:** JobVault, credentials/roles, the AI operator, approvals, real users, the landing page, the public demo job.

---

## 13. Traction plan

Traction is 30% of the score and must be genuine (testnet counts; mainnet counts more; synthetic data doesn't).

### 13.1 Who

1. **Our own business.** Our explainer-film pipeline becomes a Bursar customer: each film is a job; script, voice and render agents buy services within one budget. Tameion's FAQ says your own company counts.
2. **Other Tameion teams.** Hundreds of builders are wiring agents to money right now and all need spend limits. The MCP server + a 5-minute setup guide makes Bursar their safety layer — real businesses and real USDC inside the event window.
3. **Freelancers and small agencies running AI agents** that call paid APIs: one shared budget per client job.
4. **x402 sellers** who want buyers that can't overspend — Bursar-protected agents are safer customers.

### 13.2 How

- Day 1 Discord post; DM teams building on RFB 1–4.
- A "Protect your agent in 5 minutes" guide in the README and Discord.
- Onboard each user personally; create their first job with them.
- Weekly (twice during the event) public traction post with numbers.

### 13.3 Metrics (tracked in `metrics_daily`, shown in console)

| Metric | Maps to |
|---|---|
| Businesses onboarded / jobs created | Tameion traction question 1; RFB 4 "businesses operated" |
| USDC received and paid out (testnet vs. mainnet) | Traction question 2; RFB 4 "total USDC received and paid out" |
| Obligations settled on time without a human | RFB 4 |
| Decisions made vs. escalated, and how often the human agreed | RFB 4 |
| Overspends prevented (denials before signing) | Our headline number |
| Uncertain payments resolved correctly | Reliability proof |

Keep a `docs/traction-log.md` with dated entries, user names (with permission) and tx links.

---

## 14. Demo film

Under 3 minutes, made with our narrated-explainer pipeline, using real product footage.

| Time | Scene |
|---|---|
| 0:00–0:20 | **The problem:** three agents × 0.40 against a 1.00 budget = 1.20 |
| 0:20–0:45 | **Bursar:** a job and a budget in the vault, not the company wallet; the three-layer limit |
| 0:45–1:30 | **The race on Arc:** operator spawns sub-agents; two purchases settle; the third is denied before signing; the vault would have refused anyway. Show the operator's reasoning and its fallback. |
| 1:30–1:55 | **Escalation:** a $3 invoice goes to human approval → Telegram ping → approve → paid |
| 1:55–2:15 | **Can't be talked past:** agent key tries to raise its budget → 403; revoked agent tries a teammate's ID → rejected |
| 2:15–2:40 | **Evidence and traction:** decision page → Arc Explorer → anchored log head; real users and USDC moved |
| 2:40–3:00 | Close: "Give the agent the keys — to one job." |

---

## 15. Submission checklist

- [ ] Registered on Luma with correct GitHub + Discord handles
- [ ] Public GitHub repo; MIT license; no Reins code or assets (an "inspired by" mention is fine)
- [ ] README: problem, budget rule, architecture diagram, trust model, Arc tx links, test count, run-it-locally, known limits
- [ ] Demo video under 3 minutes (Loom / YouTube / Vimeo)
- [ ] Live product URL: landing page (`/`) with a working **Try the live demo** link to `/demo`
- [ ] Demo job is fresh (ran within the last day) and every transaction link opens Arc Explorer
- [ ] Walk the judge path from a logged-out private window: landing → demo → evidence → Arc Explorer
- [ ] Traction answers: businesses onboarded, value moved, problems solved (from `metrics_daily` + traction log)
- [ ] Clear statement of what was built during Tameion (all of it — new project)
- [ ] First submission by Oct 6; final by Oct 10, 11:59 PM ET
- [ ] Tell Canteen we intend to keep building (Q5: funding, grants, partnerships)

---

## 16. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| x402 payer vs. vault design doesn't work as hoped | Medium | Day-2 spike; option A is the safe default |
| Circle Agent Wallet / Facilitator on Arc behaves differently than docs | Medium | Spike on day 2; ask in Arc Discord early; keep executor behind an interface |
| DB policy and contract rules drift apart | Medium | Shared test vectors run against both |
| Too few real users | High | Outreach from day 1; MCP server; target other Tameion teams |
| 18- vs. 6-decimal USDC mistakes | Medium | One money module; tests at every boundary; never display two balances |
| SSRF via `quote(url)` | Medium | Payee allow-list checked before any request; DNS-pinned fetch; no private IPs |
| Nonce collisions / stuck txs from one operator key | High under load | Single sender with nonce manager (§8.11.3); fee bumps; alert on stuck > 2 min |
| Failed x402 payment strands budget in the agent wallet | Medium | `refund` + sweeper (§8.1.4) |
| DB and chain disagree after a crash | Medium | Outbox + opId idempotency + indexer as source of truth (§8.11.2) |
| Prompt injection via paid-service responses | High | Allow-listed payees, caps and vault — prompt is never the boundary (§8.11.6) |
| Leaked agent key | Medium | Scoped to one job; revocable instantly; bounded by vault; stretch: signed requests |
| Running out of time | Medium | Submit day 10; cut-line in §12 |
| LLM makes a poor purchase | Certain, occasionally | Policy + vault bound the damage; reasoning makes it reviewable; approval threshold |

---

## 17. After the hackathon

Canteen offers funding, grants and partnership support to teams that keep going. Roadmap candidates:

- Per-organisation SSO and multi-approver (m-of-n) approvals
- Signed agent requests by default; hardware-backed keys
- Policy-as-code (versioned, reviewable policy files per job)
- Counterparty screening before release (RFB 5 overlap)
- Cross-chain funding via CCTP; unified balance via Gateway
- Hosted Bursar with usage-based pricing paid in USDC via x402
- SDKs for popular agent frameworks beyond MCP

---

## 18. Reference links

- Tameion hackathon: https://tameion.thecanteenapp.com/
- Luma registration: https://luma.com/ivroypr5
- Canteen Discord: https://discord.gg/rsVfYutFZg · Arc Discord: https://discord.com/invite/buildonarc
- ARC CLI: `uv tool install git+https://github.com/the-canteen-dev/ARC-cli` · docs: arc-node.thecanteenapp.com
- Circle CLI: `npm install -g @circle-fin/cli` (Node 20.18.2+)
- Circle Agent Stack: https://developers.circle.com/agent-stack
- Arc docs: https://docs.arc.network (connect: /arc/references/connect-to-arc)
- Sample apps: circlefin/arc-x402-circle-wallets (RFB 4 starting point), circlefin/arc-nanopayments, circlefin/arc-escrow, circlefin/arc-multichain-wallet
- Agents and Ledgers essay: https://thecanteenapp.com/analysis/2026/09/12/agents-and-ledgers.html
- TestMint (testnet USDC): testmint.myproceeds.xyz
- Submission form: https://forms.gle/BBWrdfuircrKiG2i6
- Prior art (unaffiliated, design lessons only): https://github.com/Enoch208/Reins
