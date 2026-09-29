#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bursarClient } from "./client.js";
import { createServer } from "./server.js";

const key = process.env.BURSAR_AGENT_KEY;
const apiUrl = process.env.BURSAR_API_URL;
if (!key || !apiUrl) {
  // stdout belongs to the MCP protocol; everything human goes to stderr.
  console.error(
    "bursar-mcp: set BURSAR_AGENT_KEY and BURSAR_API_URL (both on the Bursar console).",
  );
  process.exit(1);
}

const server = createServer(bursarClient(apiUrl, key));
await server.connect(new StdioServerTransport());
console.error(`bursar-mcp: ready (${apiUrl})`);
