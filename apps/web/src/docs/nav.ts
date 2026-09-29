/**
 * The docs' table of contents: sidebar order, page titles and one-line descriptions. Each slug has
 * a matching `content/<slug>.mdx`. Plain data with no imports, so the Vite config can read it too
 * (for the Markdown copies and /llms.txt).
 */

export interface DocPage {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
}

export interface DocSection {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

const page = (slug: string, title: string, description: string): DocPage => ({
  slug,
  title,
  description,
});

export const docSections: readonly DocSection[] = [
  {
    title: "Get started",
    pages: [
      page(
        "introduction",
        "Introduction",
        "What Bursar is, who it's for, and how it keeps AI agents inside a budget.",
      ),
      page(
        "quickstart",
        "Quickstart",
        "Protect your agent in 5 minutes: a job, an agent key, and one command.",
      ),
      page(
        "core-ideas",
        "Core ideas",
        "Jobs, agents, payees, limits, approvals and the vault, in one page.",
      ),
    ],
  },
  {
    title: "Guides",
    pages: [
      page(
        "jobs",
        "Create and fund a job",
        "Set a budget, choose who can be paid and put the money in the vault.",
      ),
      page(
        "agents",
        "Agents, helpers and replacements",
        "Give each agent a key, let agents start helpers, and swap out a bad one.",
      ),
      page(
        "approvals",
        "Approvals",
        "Payments above your threshold wait for your signature. How that works.",
      ),
      page(
        "invoices",
        "Paying invoices",
        "Let agents pay a vendor's invoice straight from the job's funds.",
      ),
      page(
        "nanopayments",
        "Nanopayments",
        "Sub-cent purchases paid through Circle Gateway, under the same budget and rules.",
      ),
      page(
        "alerts",
        "Alerts and Telegram",
        "Hear about approvals, stuck payments and blocked agents where you are.",
      ),
      page(
        "closing",
        "Pause, close and get money back",
        "Stop spending at once, or end a job and return what's left to your wallet.",
      ),
      page(
        "connect",
        "Connect your agent",
        "Claude Code, Cursor, Claude Desktop, or any agent that can make HTTP calls.",
      ),
    ],
  },
  {
    title: "Reference",
    pages: [
      page(
        "mcp-tools",
        "MCP tools",
        "Every tool bursar-mcp gives your agent: inputs, results and examples.",
      ),
      page(
        "http-api",
        "HTTP API",
        "The agent routes, request and response shapes, and safe retries.",
      ),
      page(
        "refusal-codes",
        "Refusal codes",
        "Every reason Bursar can refuse a payment, in the order they're checked.",
      ),
      page(
        "payment-states",
        "Payment states",
        "The life of a payment, from request to settled, refunded or rejected.",
      ),
      page(
        "webhooks",
        "Webhooks",
        "Alert payloads, headers, and how to check a webhook really came from Bursar.",
      ),
      page(
        "contracts",
        "Contracts and addresses",
        "JobVault, AuditAnchor and USDC on Arc testnet.",
      ),
    ],
  },
  {
    title: "Trust",
    pages: [
      page(
        "payment-flow",
        "How a payment moves",
        "The six steps between an agent asking and a seller being paid.",
      ),
      page(
        "security",
        "Security model",
        "What stops an agent, a seller, or even our own server from overspending.",
      ),
      page(
        "audit-log",
        "Audit log and anchoring",
        "Every decision is hash-chained and sealed on Arc. Check it yourself.",
      ),
      page("limitations", "Known limits", "What Bursar doesn't do yet, stated plainly."),
    ],
  },
];

export const docPages: readonly DocPage[] = docSections.flatMap((s) => s.pages);

/** Where the MDX lives in the repo, for "Edit on GitHub". */
export const docsRepoPath = "apps/web/src/docs/content";
