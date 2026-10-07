# Day 10: launch. Landing page, public demo, MCP server, docs, and production

28–29 Sep 2026. Bursar is live: the site at [bursarhq.vercel.app](https://bursarhq.vercel.app),
the API and worker at `bursarhq-api.onrender.com`, the demo seller at
[scenestock.vercel.app](https://scenestock.vercel.app), and `bursar-mcp` on
[npm](https://www.npmjs.com/package/bursar-mcp).

## What's live

| Piece           | Where                                                                                               | Runs on                                                            |
| --------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Landing page    | [`/`](https://bursarhq.vercel.app)                                                                  | Vercel (`bursarhq`)                                                |
| Public demo job | [`/demo`](https://bursarhq.vercel.app/demo), evidence at `/demo/decisions/:id`                      | Vercel + Render                                                    |
| Docs            | [`/docs`](https://bursarhq.vercel.app/docs/introduction), `/llms.txt`, `/docs/<page>.md`            | Vercel                                                             |
| Console         | [`/login`](https://bursarhq.vercel.app/login) → `/app`                                              | Vercel + Render                                                    |
| API + worker    | `https://bursarhq-api.onrender.com`, one Node process (`scripts/start-production.mjs`)              | Render (free, Ohio)                                                |
| Database        | Postgres 17, all 11 migrations                                                                      | Neon                                                               |
| Demo seller     | [scenestock.vercel.app](https://scenestock.vercel.app) (x402, Circle facilitator)                   | Vercel (`scenestock`)                                              |
| MCP server      | `npx -y bursar-mcp` (0.1.1)                                                                         | npm                                                                |
| Audit anchor    | [`0xCe76…8ac4`](https://explorer.testnet.arc.io/address/0xCe76d1DAcbECd7dc4f6D881D673b981EdEE58ac4) | Arc testnet (verified; replaced on 7 Oct, see contracts/README.md) |

## Proven

- **The production demo job went live on Arc** from the owner's wallet, created through the live
  API (wallet sign-in, then `POST /jobs`, payees and the demo approver):
  [createJob](https://explorer.testnet.arc.io/tx/0x28c9dae5cf886d3f5709c70373d080db3314426c21cae1a9b51c71b6b5eea4da),
  [allow deposit](https://explorer.testnet.arc.io/tx/0x04aac8e12978ac7a56303903fbd9957a0c0925110194fd9451549c64fd71f044),
  [fund 2.00 USDC](https://explorer.testnet.arc.io/tx/0x9d6bf30ea0eb0ca40031f713f7185892eea6502af4b66eadb148bca11e9191a6),
  [allow the vendor](https://explorer.testnet.arc.io/tx/0x66bdbe11080f059c4d3bf87c42bad2d176ebce8d3957423f0ce5658141563b89),
  [allow the demo approver](https://explorer.testnet.arc.io/tx/0xcf3df9b7df281d30c22e5f2b419d69221e08a56a6bd4cf465c4e7b10caaa0bb3)
  and [the owner](https://explorer.testnet.arc.io/tx/0xf5f513440ccf5dddcd70244bd0e903acdf060c26226916fce619ec2b2e58c80c),
  then the customer paid 0.50 USDC in as revenue
  ([tx](https://explorer.testnet.arc.io/tx/0x09359af01b437b7778ac273714dbee959bc5c471b2247443c327d4da55db3eac)).
- **Within two minutes the AI operator bought from the public seller**, on its own: vault
  [release](https://explorer.testnet.arc.io/tx/0xb28f7d1be0598f5b72eca7b8092753e52fa5a43d7476a659c6b30ea5308e1c7b),
  x402 [payment](https://explorer.testnet.arc.io/tx/0xffe30261f2dfa94fa9ec61d1e14707d3e3ccf29e54489b77c92ec51d5ea2c9f5),
  settled. The production audit log's first anchor followed
  ([#1](https://explorer.testnet.arc.io/tx/0x15a13e372414714d9f08b815291796297cc6fb92842e6ddf4262dc57fc767430)).
- **`bursar-mcp` paid on Arc through a real MCP client.** The built server, started over stdio the
  way Claude Code starts it, listed its six tools, read the budget and sellers, and bought a script
  line: `NEEDS_APPROVAL` (that job's threshold is 0.005), approved, released, settled, and
  `check_payment` returned the seller's content labelled untrusted. After publishing, the same
  check ran through `npx -y bursar-mcp` from the npm registry.
- **The whole demo story ran end to end** before launch (Sep 28): script lines, a stock image, a
  market report approved by the demo approver
  ([release](https://explorer.testnet.arc.io/tx/0xaa3e568cc8b4ee437925056456e272ac4e609ff0b29094a561e207964d288300),
  [payment](https://explorer.testnet.arc.io/tx/0x03991ddf33e806fa386cb92ebb048de4c239f8c1b996f138297f52437ab7aadf)),
  invoice VO-12 paid straight to the vendor
  ([tx](https://explorer.testnet.arc.io/tx/0xa432482c8d4611560db0def51c580695896b7a1234b72574504902e1c86167cc)),
  and a helper with a 0.03 USDC limit refused a 0.15 purchase with `AGENT_LIMIT_EXCEEDED` while the
  job had 1.68 left.

## Landing page and demo

- **Landing** (`apps/web/src/pages/landing`): an animated hero with the explainer film and a gold
  wax seal ("Anchored on Arc"), a ticker of decisions, the overspend problem played out with and
  without Bursar, how a payment works, a prompt-injection demo, live numbers from
  `/metrics/public`, and a full footer.
- **Demo** (`/demo`): the same job page owners see, read-only and public for one job
  (`DEMO_JOB_ID`). The worker rotates its brief through five scenes every three hours and the
  operator works each one; a demo approver signs larger payments after a minute. Decisions store
  the resource that was attempted, so a blocked purchase still reads "Market report".
- **Agent marks**: every agent has a grey 5×5 pattern generated from its id, so the same agent
  looks the same everywhere and colour stays for status.

## MCP server (G14)

`apps/mcp` is standalone (no workspace imports) so it publishes and runs with `npx`. Six tools:
`get_budget`, `list_sellers`, `quote`, `purchase`, `pay_invoice`, `check_payment`. It validates
inputs the way the API does (amounts, `0x` addresses, operation ids of 8–128 characters) before
calling Bursar, returns refusals as tool errors with the API's code, and labels seller content as
untrusted. It deliberately has no tool for starting helpers: a new helper's key would pass through
the model's conversation. 8 tests drive it through a real MCP client over an in-memory transport.

New agent keys in the console now come with ready-made connection snippets (Claude Code, Cursor
and Claude Desktop, plain HTTP).

## Docs

`/docs` is 20 MDX pages (MDX 3.1.1 in the existing Vite app): Get started, Guides, Reference,
Trust. Sidebar, "On this page" that follows the scroll, Ctrl+K search (MiniSearch, indexed by
section), copy buttons, previous/next, "Edit on GitHub", a phone menu. Every page is also served as
Markdown, with `/llms.txt` and `/llms-full.txt` for agents.

Facts come from the code, and a test keeps them there: it fails if a refusal code, payment state,
MCP tool or alert type is missing from the docs, if a link or section anchor is broken, if the
contract addresses differ from the app's config, or if an example `operationId` wouldn't pass the
API. The webhook-signature samples (Node and Python) and the audit-hash sample were run against a
real Bursar signature and real log entries.

## Deploy

- **Web** (`bursarhq`): the root `vercel.json` builds `apps/web` from the monorepo;
  `VITE_API_URL`, `VITE_SITE_URL` and the WalletConnect project id are set in Vercel. The domain
  is allow-listed in Reown.
- **Seller** (`scenestock`): `apps/seller` split into a Hono app, a local server and a Vercel
  function (`hono/vercel`); self-contained so it builds on its own.
- **API and worker** (Render): one service, one Node process running both
  (`node --max-old-space-size=320 --conditions=bursar-source --import tsx
scripts/start-production.mjs`), about 195 MB. Build with `corepack pnpm@11.21.0 install`.
  UptimeRobot checks `/health` so the free instance stays awake.
- **Database** (Neon): migrations applied over the direct connection; the service uses it too,
  because the worker's lock is a session advisory lock.
- **Production AuditAnchor**: a fresh contract
  ([deploy tx](https://explorer.testnet.arc.io/tx/0xe048c34355442c3f442be31227518676fec72a33fa8a58d4b07772eb3779bc31)).
  An anchor's decision count can never go down, and the new database's log starts at zero, so it
  needs its own anchor. The development anchor keeps the history made while building.
- **Logging**: the worker logs every step as JSON; the API now logs one JSON line per request
  (method, path, status, time, role; never query strings or headers) and unhandled errors with
  their stack.

## Fixed along the way

- **Out of memory on Render.** corepack, pnpm and tsx wrappers ran seven Node processes (about
  525 MB against a 512 MB limit). Now one process with a capped heap: about 195 MB.
- **Deploys handing over.** The new instance's worker exited while the old one still held the
  worker lock, taking the API down with it. The worker now waits for the lock (tested with two
  instances locally, then on Render).
- **Demo approver polling** ran every 2-second tick and flooded the request log; it now looks
  every 30 seconds.
- **`corepack enable` fails on Render** (read-only `/usr/bin`); commands call
  `corepack pnpm@11.21.0` directly.
- **Docs search returned nothing**: the MDX plugin was compiling the `?raw` sources search reads.
  It now leaves query imports alone.
- **Operation ids**: the quickstart's example (`op-1`) and `bursar-mcp` 0.1.0 accepted ids the API
  refuses; fixed in the docs and in `bursar-mcp` 0.1.1.
- **Phone layout**: the job and demo pages overflowed at 375 px; grid columns now shrink.

## Tests

336 passing: api 101, policy 42, money 42, worker 35, payments 25, operator 21, web 14, mcp 8,
contracts 48 (Foundry).
