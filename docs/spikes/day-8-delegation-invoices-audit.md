# Day 8: delegation limits, replacements, invoices, and an audit log anchored on Arc

28 Sep 2026, Arc testnet. Everything below also runs in the test suites (API against Postgres;
worker against a local Anvil chain with the real JobVault and AuditAnchor).

## Sub-limits are carved out, never added (G9)

**The gap.** An agent's spending counted only against its own limit. Picture a parent with 0.10
left and a helper created with a 0.10 limit. Each could spend 0.10: together, twice the parent's
limit.

**The fix.**

- An agent's `committed` total now covers its whole subtree.
- A payment is checked against the agent's own limit and against every limited ancestor. This is
  still the policy engine's `AGENT_LIMIT_EXCEEDED` check, in the same fixed order.
- A release gives the amount back all the way up the tree.
- A new helper's limit must fit the tightest headroom above it.
- A migration recomputed existing totals from the payments that still hold money.

Policy vectors cover a parent limit, a grandparent limit, and the exact-fit edge. API tests show
a helper and its parent can't spend double, and that money released by a helper comes back to
every limit.

## Replacements

`POST /agents/:id/replace` (owner) and `POST /spend/subagents/:id/replace` (an agent, for its
own helpers only) both do the following in one transaction:

- Revoke the old agent, its helpers, and all their keys.
- Create the replacement in the same place in the tree, with the same role.
- Give the replacement only what the old agent had **left**. What the old agent already committed
  stays counted, so replacing never creates money.

An agent can't be replaced twice, and no replacement can ask for more than was left.

## Invoice lane (G11), live

`POST /spend/invoice {payee, amount, invoiceRef, operationId, reasoning}` runs the same policy,
reservation, approval and audit trail as a purchase. The difference is where the money goes: the
worker's vault release pays the vendor's allow-listed address directly, so **the release is the
payment**. The operator has a matching `pay_invoice` tool.

Two bugs were found on the way and fixed:

- The worker only ever picked up x402 purchases, so any payment to an address would have sat
  reserved forever.
- The approval message always named the job wallet as the recipient. For an invoice, the approver
  must sign over the vendor's address, or the vault rejects the approval.

**Live run.** Job `c5ea0453…` has a 0.005 USDC approval threshold.

1. The owner allow-listed a vendor in the vault
   ([setPayee](https://explorer.testnet.arc.io/tx/0x50a5ac48dbf98b4f0dba0e3615755ee94a93126b17bbf26dc123680efec647f7))
   and in Bursar. This raised the policy version to 3, which the indexer picked up.
2. Brief to the operator (gemini-3.1-flash-lite): "Our colourist sent invoice INV-2026-041 for
   0.02 USDC … Pay it to their wallet on the allow-list, then report."
3. The operator called `list_sellers`, found the vendor, and called `pay_invoice`. The decision
   was `NEEDS_APPROVAL`.
4. The approver signed the approval, which names the vendor's address as the recipient.
5. The vault released 0.02 straight to the vendor, checking the approver's signature itself
   ([release = payment](https://explorer.testnet.arc.io/tx/0xcad31af52e1c0254eb8faeab84dc4f0a4c73f2a9c0a2779d894b194858e5e186):
   `Released(to = vendor, amount = 20000, approved = true)`).
6. Bursar marked it `SETTLED`, and the indexer matched the payout, so the job wasn't frozen.
   There were 4 model steps costing $0.0018, and the worker logged 0 errors.

On Anvil, a test sends an invoice to a vendor that's allowed in Bursar but not in the vault. The
vault refuses it (`PayeeNotAllowed`), nothing is paid, and the reservation is released.

## Hash-chained audit log, anchored on Arc (G5)

**What gets logged.** Every decision (allowed, denied or escalated) and every payment state
change is appended to `audit_chain` **in the same transaction** as the change itself.

- A state change out of approval carries the approver's address and signature.
- Hashing uses SHA-256 with a fixed byte layout, so a browser can redo it (for the console's
  "Verify chain" button later):
  - `payloadHash = sha256(canonical JSON)`
  - `hash = sha256(prevHash ‖ seq (8 bytes) ‖ payloadHash)`
- Appends take a transaction lock, so sequence numbers are gapless even under parallel agents.
  A test runs 5 agents at once.
- A database trigger makes the table append-only.

**How it's checked.** `verifyChain` recomputes every hash and also rebuilds each decision entry
from the decision row as it stands now, so it catches all of these:

- an edited or deleted decision (the test rewrites an agent's stated reason)
- a changed payload
- a broken link or a missing entry

**How it's anchored.** The worker verifies the whole log, then calls `AuditAnchor.anchor(head,
seq, entries)`. It does this every 10 minutes when there's anything new, or after 50 entries. It
never anchors a log that fails verification (tested), and trusts `anchors(seq)` on-chain over its
own receipts.

**Live on Arc:**

| Anchor | Covers entries | What they are                                                         | Tx                                                                                                                 |
| ------ | -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| #1     | 1–6            | The 6 decisions made before the log existed, added once, oldest first | [0xa3ac36…](https://explorer.testnet.arc.io/tx/0xa3ac360f0e3da7d3a0931153ee27022c376411fd864bd7c7f258156450bbf050) |
| #2     | 7–10           | The invoice decision and its three state changes                      | [0x84bd77…](https://explorer.testnet.arc.io/tx/0x84bd77732fe7f4c8f10c3ecf61617a532bd7183bf94f55ca2d6c3ace3b98a6b8) |

`GET /audit/status` recomputes the log and confirms it reproduces the latest anchored head
(`matchesAnchor: true`). `GET /jobs/:id/audit` shows an owner their job's entries, each with the
anchor covering it.

## Tests

| Suite     | Count | New today                                                                     |
| --------- | ----- | ----------------------------------------------------------------------------- |
| policy    | 42    | ancestor-limit vectors                                                        |
| api       | 82    | delegation and replacements (9), invoices (5), audit log and routes (10)      |
| worker    | 19    | invoice paid by the vault, invoice refused by the vault, anchor (3), on Anvil |
| operator  | 20    | `pay_invoice`                                                                 |
| money     | 42    |                                                                               |
| payments  | 25    |                                                                               |
| contracts | 48    | (parity fixture regenerated; the new checks are off-chain only)               |
