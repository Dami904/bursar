# Day 9: the console, wallet sign-in, alerts, and the operator on autopilot

28 Sep 2026. The web console (`apps/web`: Vite, React, Tailwind, wagmi) talks to the Bursar API.
The design is in [DESIGN.md](../DESIGN.md): Graphite and gold, minimal but not bare.

## What an owner can do now

| Screen    | What it does                                                                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in   | "Connect wallet" (browser wallets) or "Use a phone wallet" (WalletConnect), then one free signature (Sign-In with Ethereum). Signing in is signing up; the wallet also becomes an approver for its own jobs.                                                |
| Jobs      | Each job's remaining budget, its bar, and how many payments need you.                                                                                                                                                                                       |
| New job   | Name, budget, "ask me above", end date and an optional brief; who can be paid; then the owner's wallet creates the job in the vault, funds it, allows itself as approver and allows vendors. The agent key is shown once.                                   |
| Job       | What's left, the budget bar, anything that needs you, decisions (who, when, why), the agent tree (sub-agents marked ↳; replace or revoke), the operator brief ("Run now"), and who can be paid (vendors show whether the vault allows them, read from Arc). |
| Approvals | Phone-first: amount, payee, job and the agent's reason on one card. Approve signs the exact EIP-712 message JobVault checks.                                                                                                                                |
| Evidence  | One decision as a timeline: asked, rules checked, approved, paid, anchored. "Verify" recomputes the audit hashes in the browser.                                                                                                                            |
| Metrics   | Paid out, revenue, blocked requests, approvals, live jobs, AI cost; why requests were blocked.                                                                                                                                                              |
| Alerts    | Signed webhooks and Telegram (when a bot is configured); a test alert; recent alerts with their delivery status.                                                                                                                                            |

Everything updates live. The API's `/stream` sends "change" when anything the owner can see
moves, and the console refetches. It's read with `fetch`, so the session key stays in a header.

## Proven

- **Wallet sign-in** end to end through the real `/auth` endpoints. API tests cover: a nonce
  works once; another site, another network, a made-up nonce or someone else's signature are all
  refused; sessions expire; sign-out revokes.
- **The new-job wizard, with the owner's own wallet.** The job "adaeze" went live on Arc: 1.00
  USDC deposited, the owner's wallet allowed as approver (policy version 2), and an agent key
  issued. This was the first run of the flow by a real person with a real wallet.
- **The evidence page's "Verify"** recomputed the invoice's audit hashes in the browser
  (SHA-256): they match. A unit test pins the browser's hashing to the server's.
- **Phone layout and light mode** at 375 px.
- **The production build** is 125 KB gzipped for the app. WalletConnect's screens load only when
  used.

## Alerts (G14)

The worker spots events and queues each one once in an outbox, using a unique dedupe key, then
delivers it to every target with retries (backoff up to an hour, giving up after 8 tries).

| Alert         | When                                                |
| ------------- | --------------------------------------------------- |
| Needs you     | A payment waits for approval                        |
| Stuck payment | A payment is unresolved for more than 5 minutes     |
| Budget at 80% | Once per job                                        |
| Job frozen    | An unexplained payout froze the job                 |
| Blocked burst | 3 or more requests blocked on one job in 10 minutes |

- **Webhooks** are signed: `x-bursar-signature: sha256=HMAC(secret, "<timestamp>.<body>")`. The
  secret is shown to the owner once. URLs pass the same SSRF guard as sellers.
- **Telegram:** the console opens `t.me/<bot>?start=<one-time code>`, and the worker reads the
  bot's updates and links that chat. It needs a bot token from @BotFather
  (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`).
- **Tested:** each alert type fires exactly once; the webhook signature verifies; a failing
  receiver is retried and then delivered; private addresses are refused; a Telegram chat links
  and gets the next alert; used codes are refused.

## The operator on autopilot

A job with a brief starts the AI operator by itself when it goes live, and again when a customer
pays in (the brief then says how much arrived). Each run:

- acts as the job's "Operator (auto)" agent, with a **fresh key that's revoked when the run
  ends**;
- runs one at a time across all jobs, to stay within free-tier model limits;
- if it never gets going because the model is unavailable, is retried with backoff (2 minutes,
  doubling to 30, five tries).

Revoking the auto agent stops automatic runs. The owner can edit the brief or press "Run now".

**Live.** A brief was set on job `c5ea0453…`. The worker started the operator within one tick, with
no command. Gemini was overloaded at the time (503 "high demand" on both Flash-Lite models, and
the plain smoke test failed too). The run did nothing and spent nothing. The retry logic took
over, with attempts at 2, 4 and 8 minutes. Four runs made four keys, and all four were revoked
afterwards. This also led to one change: the fallback model now also takes over when the default
stays overloaded at the start of a run, not only when its daily quota is gone.

## Fixed along the way

- A live-stream loop: a new callback on every render restarted the stream hundreds of times.
- Vite's `resolve.conditions` replaced the browser defaults, so the build pulled in Node-only code.
- A flaky anchor test (a 3-second receipt timeout under load).
- A clock mismatch between queued alerts and the sender.

## Tests

operator 21 · money 42 · policy 42 · payments 25 · api 99 · web 4 · worker 30 · contracts 48.
