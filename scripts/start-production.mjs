/**
 * Runs the API and the worker in one Node process (Render's free plan gives one 512 MB
 * instance). One process instead of a tree of pnpm and tsx wrappers keeps memory well under the
 * limit. If either part throws on startup, the process exits and the platform restarts it.
 *
 *   node --conditions=bursar-source --import tsx scripts/start-production.mjs
 */
await import("../apps/api/src/server.ts");
await import("../apps/worker/src/main.ts");
