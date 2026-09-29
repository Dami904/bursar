import { config } from "./config.js";

/** How an agent connects to Bursar: the same three snippets on the quickstart and the key reveal. */
export type ConnectTarget = "claude-code" | "json" | "http";

export const connectTargets: { id: ConnectTarget; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "json", label: "Cursor · Claude Desktop" },
  { id: "http", label: "HTTP API" },
];

export function connectSnippet(target: ConnectTarget, key: string, apiUrl = config.apiUrl) {
  switch (target) {
    case "claude-code":
      return `claude mcp add bursar \\
  --env BURSAR_AGENT_KEY=${key} \\
  --env BURSAR_API_URL=${apiUrl} \\
  -- npx -y bursar-mcp`;
    case "json":
      return JSON.stringify(
        {
          mcpServers: {
            bursar: {
              command: "npx",
              args: ["-y", "bursar-mcp"],
              env: { BURSAR_AGENT_KEY: key, BURSAR_API_URL: apiUrl },
            },
          },
        },
        null,
        2,
      );
    case "http":
      return `curl -X POST ${apiUrl}/spend/purchase \\
  -H "authorization: Bearer ${key}" \\
  -H "content-type: application/json" \\
  -d '{"operationId":"report-2026-001","url":"https://seller.example/v1/report","maxPrice":"0.05","reasoning":"Needed for the brief"}'`;
  }
}

export const connectHint: Record<ConnectTarget, string> = {
  "claude-code":
    "Run in your project. The agent gets six tools: budget, sellers, quote, purchase, invoices, check payment.",
  json: "Add to .cursor/mcp.json, or claude_desktop_config.json, then restart the app.",
  http: "No MCP? Any agent can call the API. Retrying with the same operationId never pays twice.",
};
