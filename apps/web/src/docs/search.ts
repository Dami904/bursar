import GithubSlugger from "github-slugger";
import MiniSearch from "minisearch";
import { docPages } from "./nav.js";

export interface SearchSection {
  id: string;
  slug: string;
  page: string;
  heading: string;
  anchor: string;
  text: string;
}

/** Markdown to plain words for the index: no links, marks, tables or components. */
function plain(markdown: string): string {
  return markdown
    .replace(/^(import|export) .*$/gm, "")
    .replace(/^\s*<\/?[A-Z][^>]*>\s*$/gm, "")
    .replace(/```\w*/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>|#]/g, " ")
    .replace(/-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits each page at its ## and ### headings, so a result can jump straight to the section.
 * Anchors are made the way rehype-slug makes the page's heading ids.
 */
export function sectionsOf(slug: string, page: string, source: string): SearchSection[] {
  const slugger = new GithubSlugger();
  const sections: SearchSection[] = [];
  let heading = page;
  let anchor = "";
  let buffer: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = plain(buffer.join("\n"));
    if (text !== "" || anchor === "") {
      sections.push({ id: `${slug}#${anchor}`, slug, page, heading, anchor, text });
    }
    buffer = [];
  };
  for (const line of source.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const match = inFence ? null : /^#{2,4}\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1].replace(/[`*]/g, "").trim();
      anchor = slugger.slug(heading);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

let index: Promise<MiniSearch<SearchSection>> | null = null;

/** Built on first use: loads every page's source and indexes it by section. */
export function searchIndex(): Promise<MiniSearch<SearchSection>> {
  index ??= (async () => {
    const sources = import.meta.glob<string>("./content/*.mdx", {
      query: "?raw",
      import: "default",
    });
    const mini = new MiniSearch<SearchSection>({
      fields: ["page", "heading", "text"],
      storeFields: ["slug", "page", "heading", "anchor", "text"],
      searchOptions: { boost: { page: 3, heading: 2 }, prefix: true, fuzzy: 0.2 },
    });
    for (const p of docPages) {
      const load = sources[`./content/${p.slug}.mdx`];
      if (load === undefined) continue;
      mini.addAll(sectionsOf(p.slug, p.title, `${p.description}\n${await load()}`));
    }
    return mini;
  })();
  return index;
}

/** A short piece of the section around the first word that matched. */
export function snippet(text: string, terms: string[], length = 150): string {
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  const start = Math.max(0, (at.length > 0 ? Math.min(...at) : 0) - 40);
  const piece = text.slice(start, start + length);
  return `${start > 0 ? "…" : ""}${piece}${start + length < text.length ? "…" : ""}`;
}
