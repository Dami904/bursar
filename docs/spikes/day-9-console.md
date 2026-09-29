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
- **Live on Telegram:** the owner connected @bursar_alerts_bot from the console (one-time link,
  then Start) and the test alert arrived. One chat per account: once linked, the button hides, and
  a newer link replaces the old chat rather than doubling alerts.
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

**Live.**

- **Retries while Gemini was down.** Gemini was overloaded for about half an hour (503 "high
  demand" on both Flash-Lite models; the plain smoke test failed too). Runs that never got going
  were retried at 2, 4 and 8 minutes.
- **Change prompted by the outage.** The fallback model now also takes over when the default stays
  overloaded at the start of a run, not only when its daily quota is gone.
- **A full automatic run.** Once Gemini recovered, "Run now" on job `c5ea0453…` did it end to end,
  with no command. The operator checked the budget, read the sellers, quoted, and bought the
  insight. The purchase needed approval; after approval it settled on Arc
  ([payment](https://explorer.testnet.arc.io/tx/0xbfa207876a93a06e2a482f76442089cac0eda373a860992ef2e944cc0e8f2910)).
  The run completed for $0.0023 of AI cost.
- **The time limit.** A later run stopped at the 5-minute limit while Gemini was slow (about 4
  minutes per call), having spent nothing.
- **Keys.** All 6 automatic runs' keys were revoked afterwards.
- **Alerts.** A purchase left waiting for approval produced "0.01 USDC needs your approval", with
  the job, the agent's reason and a link to Approvals.

## Closing, pausing and unfreezing

The job page's menu has **Pause job**, **Resume job** and **Close job**, all signed by the owner's
wallet. Close is allowed only when nothing is held, waiting or stuck, and it returns every unspent
USDC to the owner in the same transaction. A frozen job shows why, with **"I've checked it,
unfreeze"**, which clears the freeze in Bursar and then resumes the job on-chain. Closed jobs are
read-only and show what was spent.

**Live on Arc**, using the day-5 test job (the same vault calls the buttons make):

- [pause](https://explorer.testnet.arc.io/tx/0xe422f281b5e74dd56456967d1805ecd1a74ba7e3a79ce1d7fc31b18322c245cb):
  Bursar showed PAUSED within seconds.
- [resume](https://explorer.testnet.arc.io/tx/0x4c7ea93df3dcc1af9f6cc7a8243eb4a163f4b918561728a8b3662aedfff57f6b):
  ACTIVE again.
- [close](https://explorer.testnet.arc.io/tx/0x26ae57a782b8edce2102b5effb8eea76de3f6fd71ac9f472b1246f2c52642e0c):
  0.57 USDC came back to the owner's wallet (the 0.47 of budget left plus 0.10 of revenue; the
  wallet rose by 0.5679 after the 0.0021 gas). Bursar showed CLOSED.

## Fixed along the way

- A live-stream loop: a new callback on every render restarted the stream hundreds of times.
- Vite's `resolve.conditions` replaced the browser defaults, so the build pulled in Node-only code.
- A clock mismatch in the anchor job: `sentAt` came from the database's clock, which ran about
  300 ms ahead of the worker's, so "has the interval passed?" could come out negative. It's now
  stamped with the worker's clock (the anchor test had looked flaky because of this).
- CI's first run failed: `@bursar/payments` had no test config for reading workspace sources, and
  had only passed locally thanks to a stale `money/dist`. Fixed and checked with no builds present.
- The same clock mismatch between queued alerts and their sender.

## Tests

operator 21 · money 42 · policy 42 · payments 25 · api 99 · web 4 · worker 30 · contracts 48.
