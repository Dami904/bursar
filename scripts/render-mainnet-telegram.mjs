/* global console, fetch, URL */
/**
 * Gives the Arc mainnet service its own Telegram bot (a bot can only be polled by one service).
 *
 *   node scripts/render-mainnet-telegram.mjs
 *
 * Reads MAINNET_TELEGRAM_BOT_TOKEN and MAINNET_TELEGRAM_BOT_USERNAME from .env, sets them on
 * bursarhq-mainnet-api as TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME, and redeploys it.
 * Nothing secret is printed.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const NAME = "bursarhq-mainnet-api";

// Read .env directly: a variable already set on the machine would win over process.loadEnvFile.
const file = parseEnv(readFileSync(new URL("../.env", import.meta.url), "utf8"));
const need = (name) => {
  const value = file[name]?.trim();
  if (!value) throw new Error(`${name} is missing from .env`);
  return value;
};
const token = need("MAINNET_TELEGRAM_BOT_TOKEN");
const username = need("MAINNET_TELEGRAM_BOT_USERNAME").replace(/^@/, "");
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("that doesn't look like a bot token");
if (!/^[A-Za-z0-9_]{5,32}bot$/i.test(username)) throw new Error("a bot's username ends in 'bot'");

// The token must belong to the username we're about to advertise.
const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
if (!me.ok) throw new Error("Telegram rejected the token");
if (me.result.username.toLowerCase() !== username.toLowerCase()) {
  throw new Error(`the token is for @${me.result.username}, not @${username}`);
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

const [found] = (await render(`/services?name=${encodeURIComponent(NAME)}&limit=20`)).filter(
  (item) => item.service.name === NAME,
);
if (found === undefined) throw new Error(`${NAME} not found`);
const id = found.service.id;

for (const [key, value] of [
  ["TELEGRAM_BOT_TOKEN", token],
  ["TELEGRAM_BOT_USERNAME", me.result.username],
]) {
  await render(`/services/${id}/env-vars/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  console.log(`set ${key} on ${NAME}`);
}
const deploy = await render(`/services/${id}/deploys`, { method: "POST", body: "{}" });
console.log(`bot @${me.result.username}; redeploy ${deploy.id ?? deploy.deploy?.id} started`);
