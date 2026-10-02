/* global console, fetch, process, URL */
/**
 * Creates the Arc mainnet API and worker service on Render, once.
 *
 *   node scripts/render-mainnet.mjs
 *
 * Same repo, branch, build and start as the testnet service (bursarhq-api); mainnet settings.
 * Secrets are read from .env and ~/.bursar-mainnet and sent only to Render's API: nothing
 * secret is printed. Stops if a service with this name already exists.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const NAME = "bursarhq-mainnet-api";
const WEB = "https://bursarhq-mainnet.vercel.app";
const TESTNET_SERVICE = "srv-datp6ffavr4c73ee6dr0";

// Read .env directly: process.loadEnvFile never overrides a variable the machine already has,
// and a RENDER_API_KEY set system-wide (another account) would silently win.
const file = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
const need = (name) => {
  const value = file[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
};
const operator = JSON.parse(readFileSync("C:/Users/USER/.bursar-mainnet/operator.json", "utf8"));
const deployment = JSON.parse(
  readFileSync(new URL("../contracts/deployments/5042.json", import.meta.url), "utf8"),
);
if (deployment.chainId !== 5042) throw new Error("deployments/5042.json isn't Arc mainnet");
if (deployment.operator.toLowerCase() !== operator.address.toLowerCase()) {
  throw new Error("the vault's operator isn't the key in operator.json");
}

const render = async (path, init = {}) => {
  const response = await fetch(`https://api.render.com/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${need("RENDER_API_KEY")}`,
      accept: "application/json",
      "content-type": "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`Render ${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
};

const existing = await render(`/services?name=${encodeURIComponent(NAME)}&limit=20`);
if (existing.some((item) => item.service.name === NAME)) {
  console.log(`${NAME} already exists: nothing created`);
  process.exit(0);
}
const testnet = await render(`/services/${TESTNET_SERVICE}`);
const details = testnet.serviceDetails;

const envVars = Object.entries({
  NODE_VERSION: "24",
  HOST: "0.0.0.0",
  API_PORT: "10000",
  ARC_CHAIN_ID: "5042",
  ARC_RPC_URL: "https://rpc.mainnet.arc.io",
  USDC_ADDRESS: deployment.usdc,
  JOB_VAULT_ADDRESS: deployment.jobVault,
  JOB_VAULT_DEPLOY_BLOCK: String(deployment.deployedAtBlock),
  AUDIT_ANCHOR_ADDRESS: deployment.auditAnchor,
  OPERATOR_PRIVATE_KEY: operator.privateKey,
  CIRCLE_API_KEY: need("CIRCLE_MAINNET_API_KEY"),
  CIRCLE_ENTITY_SECRET: need("CIRCLE_MAINNET_ENTITY_SECRET"),
  CIRCLE_WALLET_SET_ID: need("CIRCLE_MAINNET_WALLET_SET_ID"),
  DATABASE_URL: need("MAINNET_NEON_CONNECTION_STRING"),
  WEB_URL: WEB,
  WEB_ORIGINS: WEB,
  BURSAR_API_URL: `https://${NAME}.onrender.com`,
  MAX_JOB_BUDGET: "5",
  AUTOPILOT: "false",
  ALLOW_PRIVATE_PAYEES: "false",
  ALLOW_PRIVATE_WEBHOOKS: "false",
}).map(([key, value]) => ({ key, value }));

const created = await render("/services", {
  method: "POST",
  body: JSON.stringify({
    type: "web_service",
    name: NAME,
    ownerId: testnet.ownerId,
    repo: testnet.repo,
    branch: "main",
    autoDeploy: "yes",
    envVars,
    serviceDetails: {
      runtime: details.runtime ?? "node",
      plan: "free",
      region: details.region,
      healthCheckPath: "/health",
      envSpecificDetails: {
        buildCommand: details.envSpecificDetails.buildCommand,
        startCommand: details.envSpecificDetails.startCommand,
      },
    },
  }),
});
const service = created.service ?? created;
console.log("created", service.id, service.name, service.serviceDetails?.url ?? "");
console.log("settings sent:", envVars.map((v) => v.key).join(" "));
