# bursar-mcp

Give any MCP agent (Claude Code, Cursor, Claude Desktop, your own) a **Bursar agent key** instead of a wallet. It can pay for what its job needs, in USDC on Arc, and nothing past the limits the owner set: budget, per-payment cap, allowed sellers, approvals. The same limits are enforced by the JobVault contract on-chain.

## Connect

Create a job and an agent in the Bursar console, copy the agent key, then:

```bash
claude mcp add bursar --env BURSAR_AGENT_KEY=bsr_agt_... --env BURSAR_API_URL=https://<bursar-api> -- npx -y bursar-mcp
```

Or in `.cursor/mcp.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bursar": {
      "command": "npx",
      "args": ["-y", "bursar-mcp"],
      "env": { "BURSAR_AGENT_KEY": "bsr_agt_...", "BURSAR_API_URL": "https://<bursar-api>" }
    }
  }
}
```

## Tools

| Tool                 | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `get_budget`         | Remaining budget, per-payment cap, approval threshold, expiry        |
| `list_sellers`       | Allowed x402 sellers (with catalogs) and vendor wallets              |
| `search_marketplace` | Find services in an allowed marketplace (Circle's Agent Marketplace) |
| `quote`              | A seller's price, without buying                                     |
| `purchase`           | Buy from an allowed x402 seller; returns the content                 |
| `pay_invoice`        | Pay a vendor's invoice to its allow-listed wallet                    |
| `check_payment`      | Follow a payment that is waiting for approval or still settling      |

`quote` and `purchase` take an optional `method` (`GET` by default, or `POST`) and a JSON `body` of up to 4 KB, for sellers such as search APIs that answer `POST`.

Refusals come back as tool errors or `denial_reason` codes (`PAYEE_NOT_ALLOWED`, `PER_TX_CAP_EXCEEDED`, `AGENT_LIMIT_EXCEEDED`, `JOB_BUDGET_EXCEEDED`, …) so the agent can change plans. Payments take an optional `operation_id`: retrying with the same one never pays twice. Seller content is returned as `untrusted_seller_content`.

## Develop

```bash
pnpm --filter bursar-mcp test      # in-memory MCP client against the server
pnpm --filter bursar-mcp build
BURSAR_AGENT_KEY=... BURSAR_API_URL=http://127.0.0.1:8787 pnpm --filter bursar-mcp smoke [--buy <url> <max>] [--check <paymentId>]
```

The package has no workspace dependencies, so it publishes and runs on its own.
