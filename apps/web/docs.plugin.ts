import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { docPages, docSections } from "./src/docs/nav";

/**
 * The docs for agents: every page as plain Markdown at /docs/<slug>.md, an index at /llms.txt
 * (https://llmstxt.org) and everything in one file at /llms-full.txt. Built from the same MDX the
 * site renders, so the two never disagree. Served by the dev server and emitted in the build.
 */

const contentDir = fileURLToPath(new URL("./src/docs/content/", import.meta.url));
const site = process.env.VITE_SITE_URL ?? "";

/** What the connect tabs show, as plain Markdown for readers without the live component. */
const connectMarkdown = [
  "Claude Code:",
  "",
  "```bash",
  "claude mcp add bursar --env BURSAR_AGENT_KEY=bsr_agt_... --env BURSAR_API_URL=$BURSAR_API_URL -- npx -y bursar-mcp",
  "```",
  "",
  "Cursor or Claude Desktop (`mcpServers` in the app's MCP config):",
  "",
  "```json",
  '{ "mcpServers": { "bursar": { "command": "npx", "args": ["-y", "bursar-mcp"], "env": { "BURSAR_AGENT_KEY": "bsr_agt_...", "BURSAR_API_URL": "$BURSAR_API_URL" } } } }',
  "```",
];

/** MDX to Markdown: drops imports and live components, turns callouts into blockquotes. */
export function mdxToMarkdown(source: string): string {
  const out: string[] = [];
  let inCallout = false;
  let inFence = false;
  for (const line of source.split(/\r?\n/)) {
    const fence = line.trimStart().startsWith("```");
    if (fence) inFence = !inFence;
    if (inFence || fence) {
      out.push(inCallout ? `> ${line}` : line);
      continue;
    }
    if (/^(import|export) /.test(line)) continue;
    const open = /^<Callout(?:\s+type="(\w+)")?\s*>$/.exec(line.trim());
    if (open) {
      inCallout = true;
      out.push(`> **${open[1] === "warn" ? "Warning" : "Note"}:**`);
      continue;
    }
    if (line.trim() === "</Callout>") {
      inCallout = false;
      continue;
    }
    if (/^\s*<ConnectTabs[\s/>]/.test(line)) {
      out.push(...connectMarkdown);
      continue;
    }
    // Other live components render in the browser only; their text is in the surrounding prose.
    if (/^\s*<[A-Z][\w.]*[\s/>]/.test(line)) continue;
    out.push(inCallout ? (line.trim() === "" ? ">" : `> ${line}`) : line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageMarkdown(slug: string): string | null {
  const page = docPages.find((p) => p.slug === slug);
  if (page === undefined) return null;
  const source = readFileSync(`${contentDir}${slug}.mdx`, "utf8");
  return `# ${page.title}\n\n> ${page.description}\n\n${mdxToMarkdown(source)}\n`;
}

function llmsIndex(): string {
  const sections = docSections.map(
    (s) =>
      `## ${s.title}\n\n${s.pages
        .map((p) => `- [${p.title}](${site}/docs/${p.slug}.md): ${p.description}`)
        .join("\n")}`,
  );
  return `# Bursar\n\n> Job-scoped, on-chain spending limits for AI agent teams, paid in USDC on Arc. Agents get a scoped key instead of a wallet; every payment is checked against the job's budget, caps, allowed payees and approvals, and the same limits are enforced by the JobVault contract.\n\nConnect an agent with the MCP server: \`npx -y bursar-mcp\` (needs BURSAR_AGENT_KEY and BURSAR_API_URL).\n\n${sections.join("\n\n")}\n`;
}

function llmsFull(): string {
  return docPages.map((p) => pageMarkdown(p.slug)).join("\n\n---\n\n");
}

export function docsForAgents(): Plugin {
  return {
    name: "bursar-docs-for-agents",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        let body: string | null = null;
        if (path === "/llms.txt") body = llmsIndex();
        else if (path === "/llms-full.txt") body = llmsFull();
        else {
          const match = /^\/docs\/([a-z0-9-]+)\.md$/.exec(path);
          if (match?.[1] !== undefined) body = pageMarkdown(match[1]);
        }
        if (body === null) return next();
        res.setHeader("content-type", "text/markdown; charset=utf-8");
        res.end(body);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "llms.txt", source: llmsIndex() });
      this.emitFile({ type: "asset", fileName: "llms-full.txt", source: llmsFull() });
      for (const p of docPages) {
        this.emitFile({
          type: "asset",
          fileName: `docs/${p.slug}.md`,
          source: pageMarkdown(p.slug) ?? "",
        });
      }
    },
  };
}
