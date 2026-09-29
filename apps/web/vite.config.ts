import mdx from "@mdx-js/rollup";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { defaultClientConditions, defineConfig } from "vite";
import { docsForAgents } from "./docs.plugin";

/**
 * MDX for the docs pages. `?raw` imports (the search index reads the page sources) must stay
 * text, so anything with a query string is left alone.
 */
function docsMdx() {
  const plugin = mdx({ remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] });
  const transform = plugin.transform as (this: unknown, code: string, id: string) => unknown;
  return {
    ...plugin,
    enforce: "pre" as const,
    transform(this: unknown, code: string, id: string) {
      return id.includes("?") ? null : transform.call(this, code, id);
    },
  };
}

export default defineConfig({
  plugins: [
    // Docs pages: Markdown with GitHub tables, and heading ids for links and "On this page".
    docsMdx(),
    react(),
    tailwindcss(),
    docsForAgents(),
  ],
  // Workspace packages are consumed from source, like everywhere else in the monorepo.
  // Setting conditions replaces Vite's defaults, so keep the browser ones: without them packages
  // resolve to their Node builds.
  resolve: { conditions: ["bursar-source", ...defaultClientConditions] },
  // One .env for the whole repo. Vite only exposes VITE_* variables to the browser.
  envDir: "../..",
  server: { port: 5173, strictPort: true },
});
