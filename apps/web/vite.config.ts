import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Workspace packages are consumed from source, like everywhere else in the monorepo.
  // Setting conditions replaces Vite's defaults, so keep the browser ones: without them packages
  // resolve to their Node builds.
  resolve: { conditions: ["bursar-source", ...defaultClientConditions] },
  // One .env for the whole repo. Vite only exposes VITE_* variables to the browser.
  envDir: "../..",
  server: { port: 5173, strictPort: true },
});
