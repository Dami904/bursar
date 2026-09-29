import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mdxToMarkdown } from "../../docs.plugin.js";
import { config } from "../lib/config.js";
import { docPages } from "./nav.js";
import { sectionsOf } from "./search.js";

/**
 * Keeps the docs honest: every code, state, tool and alert that exists in the code is documented,
 * every link inside the docs lands somewhere, and examples use values the API accepts.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const content = (slug: string) => read(`apps/web/src/docs/content/${slug}.mdx`);

/** The string literals of an `export const name = [ ... ] as const` list. */
function listIn(source: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source);
  if (match?.[1] === undefined) throw new Error(`${name} not found`);
  return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

describe("docs", () => {
  it("has one page per sidebar entry, and no page missing from the sidebar", () => {
    const files = readdirSync(`${root}apps/web/src/docs/content`)
      .filter((f) => f.endsWith(".mdx"))
      .map((f) => f.replace(/\.mdx$/, ""))
      .sort();
    expect(files).toEqual(docPages.map((p) => p.slug).sort());
  });

  it("documents every refusal code, in the order they're checked", () => {
    const codes = listIn(read("packages/policy/src/policy.ts"), "denialReasons");
    const page = content("refusal-codes");
    const positions = codes.map((c) => page.indexOf(`\`${c}\``));
    expect(
      positions.every((p) => p >= 0),
      `missing: ${codes.filter((_, i) => positions[i] === -1)}`,
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("documents every payment state", () => {
    const states = listIn(read("packages/policy/src/states.ts"), "authorizationStates");
    const page = content("payment-states");
    expect(states.filter((s) => !page.includes(`\`${s}\``))).toEqual([]);
  });

  it("documents every MCP tool", () => {
    const tools = [...read("apps/mcp/src/server.ts").matchAll(/registerTool\(\s*"(\w+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(tools.length).toBeGreaterThan(0);
    const page = content("mcp-tools");
    expect(tools.filter((t) => !page.includes(`## ${t}`))).toEqual([]);
  });

  it("documents every alert type", () => {
    const worker = read("apps/worker/src/alerts.ts");
    const api = read("apps/api/src/services/alerts.ts");
    const types = [...`${worker}\n${api}`.matchAll(/type: "([a-z_0-9]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(types.length).toBeGreaterThan(0);
    const page = content("webhooks");
    expect(types.filter((t) => !page.includes(`\`${t}\``))).toEqual([]);
  });

  it("lists the contract addresses the app uses", () => {
    const page = content("contracts");
    expect(page).toContain(config.vault);
    expect(page).toContain(config.usdc);
    expect(page).toContain(String(config.chain.id));
  });

  it("links only to pages and sections that exist", () => {
    const anchors = new Map(
      docPages.map((p) => [
        p.slug,
        new Set(sectionsOf(p.slug, p.title, content(p.slug)).map((s) => s.anchor)),
      ]),
    );
    const broken: string[] = [];
    for (const p of docPages) {
      for (const [, slug, anchor] of content(p.slug).matchAll(
        /\]\(\/docs\/([^)#\s]+)(?:#([^)\s]+))?\)/g,
      )) {
        const target = anchors.get(slug as string);
        if (target === undefined || (anchor !== undefined && !target.has(anchor))) {
          broken.push(`${p.slug} → ${slug}${anchor ? `#${anchor}` : ""}`);
        }
      }
      for (const [, anchor] of content(p.slug).matchAll(/\]\(#([^)\s]+)\)/g)) {
        if (!anchors.get(p.slug)?.has(anchor as string)) broken.push(`${p.slug} → #${anchor}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("uses operation ids the API accepts in every example", () => {
    const ids = docPages.flatMap((p) =>
      [...content(p.slug).matchAll(/"operationId":\s*"([^"]+)"/g)].map((m) => m[1] as string),
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !/^[A-Za-z0-9_-]{8,128}$/.test(id))).toEqual([]);
  });
});

describe("docs as Markdown", () => {
  it("drops live components and turns callouts into blockquotes", () => {
    const md = mdxToMarkdown(
      [
        "Intro.",
        "",
        '<ConnectTabs agentKey="x" />',
        "",
        '<Callout type="warn">',
        "",
        "Careful.",
        "",
        "</Callout>",
      ].join("\n"),
    );
    expect(md).not.toContain("<ConnectTabs");
    expect(md).toContain("npx -y bursar-mcp");
    expect(md).toContain("> **Warning:**");
    expect(md).toContain("> Careful.");
  });

  it("leaves code blocks alone", () => {
    const md = mdxToMarkdown(["```ts", 'import { x } from "y";', "<Foo />", "```"].join("\n"));
    expect(md).toContain('import { x } from "y";');
    expect(md).toContain("<Foo />");
  });
});
