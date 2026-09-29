/**
 * Runs the built server exactly as Claude Code or Cursor would (a child process over stdio) and
 * calls its tools. Read-only unless --buy is given.
 *
 *   BURSAR_AGENT_KEY=bsr_agt_... BURSAR_API_URL=http://127.0.0.1:8787 pnpm --filter bursar-mcp smoke [--buy <url> <maxPrice>] [--check <paymentId>]
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

const client = new Client({ name: "bursar-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env }));

function show(label: string, result: Awaited<ReturnType<Client["callTool"]>>) {
  const [first] = result.content as { text: string }[];
  console.log(`\n# ${label}${result.isError ? " (error)" : ""}\n${first?.text ?? ""}`);
}

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
show("get_budget", await client.callTool({ name: "get_budget", arguments: {} }));
show("list_sellers", await client.callTool({ name: "list_sellers", arguments: {} }));

const buy = process.argv.indexOf("--buy");
if (buy !== -1) {
  const [url, maxPrice] = process.argv.slice(buy + 1);
  show(
    "purchase",
    await client.callTool({
      name: "purchase",
      arguments: {
        url,
        max_price: maxPrice,
        reasoning: "MCP smoke test from the bursar-mcp package",
      },
    }),
  );
}
const check = process.argv.indexOf("--check");
if (check !== -1) {
  const paymentId = process.argv[check + 1];
  show(
    "check_payment",
    await client.callTool({ name: "check_payment", arguments: { payment_id: paymentId } }),
  );
}
await client.close();
