/* global console, fetch, process, URL */
/**
 * Turns on Bursar's own AI operator for the Arc mainnet service.
 *
 *   node scripts/render-mainnet-operator.mjs
 *
 * Copies the testnet service's GEMINI_API_KEY to bursarhq-mainnet-api (one key, one bill) and sets
 * AUTOPILOT=true, then redeploys. With PUBLIC_JOB_ID=<job id> as an argument, also shows that job
 * read-only at /demo, without the testnet demo's automation. Nothing secret is printed.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const NAME = "bursarhq-mainnet-api";
const TESTNET_SERVICE = "srv-datp6ffavr4c73ee6dr0";
const publicJob = /^PUBLIC_JOB_ID=([0-9a-f-]{36})$/.exec(process.argv[2] ?? "")?.[1];

// Read .env directly: a variable already set on the machine would win over process.loadEnvFile.
const file = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
const renderKey = file.RENDER_API_KEY?.trim();
if (!renderKey) throw new Error("RENDER_API_KEY is missing from .env");

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

const testnetVars = await render(`/services/${TESTNET_SERVICE}/env-vars?limit=100`);
const gemini = testnetVars.find((v) => v.envVar.key === "GEMINI_API_KEY")?.envVar.value;
if (!gemini) throw new Error("The testnet service has no GEMINI_API_KEY to copy");

const [found] = (await render(`/services?name=${encodeURIComponent(NAME)}&limit=20`)).filter(
  (item) => item.service.name === NAME,
);
if (found === undefined) throw new Error(`${NAME} not found`);
const id = found.service.id;

const settings = [
  ["GEMINI_API_KEY", gemini],
  ["AUTOPILOT", "true"],
  ...(publicJob === undefined ? [] : [["PUBLIC_JOB_ID", publicJob]]),
];
for (const [key, value] of settings) {
  await render(`/services/${id}/env-vars/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  console.log(`set ${key} on ${NAME}`);
}
const deploy = await render(`/services/${id}/deploys`, { method: "POST", body: "{}" });
console.log(`redeploy ${deploy.id ?? deploy.deploy?.id} started`);
