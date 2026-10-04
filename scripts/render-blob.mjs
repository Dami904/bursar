/* global console, fetch, URL */
/**
 * Gives both Render services the Vercel Blob token, so their workers can keep the images, audio and
 * video that sellers deliver.
 *
 *   node scripts/render-blob.mjs
 *
 * Reads BLOB_READ_WRITE_TOKEN and RENDER_API_KEY from .env, sets the token on the testnet and the
 * mainnet API services (the worker runs inside them) and redeploys each. Nothing secret is printed.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const SERVICES = { testnet: "srv-datp6ffavr4c73ee6dr0", mainnet: "srv-davgotm7bikc73e0ltjg" };

// Read .env directly: a variable already set on the machine would win over process.loadEnvFile.
const file = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
const renderKey = file.RENDER_API_KEY?.trim();
const token = file.BLOB_READ_WRITE_TOKEN?.trim();
if (!renderKey) throw new Error("RENDER_API_KEY is missing from .env");
if (!token?.startsWith("vercel_blob_rw_")) {
  throw new Error("BLOB_READ_WRITE_TOKEN in .env should start with vercel_blob_rw_");
}

const render = async (path, init = {}) => {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${renderKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`Render ${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
};

for (const [name, id] of Object.entries(SERVICES)) {
  await render(`/services/${id}/env-vars/BLOB_READ_WRITE_TOKEN`, {
    method: "PUT",
    body: JSON.stringify({ value: token }),
  });
  console.log(`set BLOB_READ_WRITE_TOKEN on ${name}`);
  const deploy = await render(`/services/${id}/deploys`, { method: "POST", body: "{}" });
  console.log(`${name}: deploy ${deploy.id} started`);
}
