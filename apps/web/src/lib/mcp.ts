import { config } from "./config.js";

/** How an agent connects to Bursar: the same three snippets on the quickstart and the key reveal. */
export type ConnectTarget = "claude-code" | "claude-code-windows" | "json" | "http";

export const connectTargets: { id: ConnectTarget; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-code-windows", label: "Claude Code (Windows)" },
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
    case "claude-code-windows":
      // One line for PowerShell (no "\" line breaks there). '--' is quoted because PowerShell
      // swallows a bare --, and Claude Code on Windows starts npx through cmd /c.
      return `claude mcp add bursar --env BURSAR_AGENT_KEY=${key} --env BURSAR_API_URL=${apiUrl} '--' cmd /c npx -y bursar-mcp`;
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
    "Run in your project's terminal (macOS, Linux). The agent gets seven tools: budget, sellers, marketplace search, quote, purchase, invoices, check payment.",
  "claude-code-windows":
    "Paste into PowerShell as one line, in your project folder. Then run claude mcp list: bursar should show as connected.",
  json: "Add to .cursor/mcp.json, or claude_desktop_config.json, then restart the app.",
  http: "No MCP? Any agent can call the API. Retrying with the same operationId never pays twice.",
};
