import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import { Hono } from "hono";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CircleFacilitatorClient } from "./circle-facilitator.js";
import type { SellerEnv } from "./env.js";

/**
 * Our x402 seller: a few fixed-price resources, paid in USDC on Arc through Circle's facilitator.
 * Built as a plain Hono app so it runs locally (server.ts) or as a serverless function (api/).
 */
export function createSellerApp(env: SellerEnv) {
  const seller = privateKeyToAccount(env.SELLER_PRIVATE_KEY as `0x${string}`);
  if (getAddress(seller.address) !== getAddress(env.SELLER_ADDRESS)) {
    throw new Error("SELLER_PRIVATE_KEY does not control SELLER_ADDRESS");
  }

  const network = `eip155:${env.ARC_CHAIN_ID}` as const;
  const facilitator = new CircleFacilitatorClient({ seller, network });
  const resourceServer = new x402ResourceServer(facilitator).register(
    network,
    new ExactEvmScheme(),
  );

  // Nanopayments: sub-cent prices paid through Circle Gateway, which verifies each signed payment
  // off-chain and settles them on Arc in batches. Circle's client defaults to mainnet.
  const gatewayServer = new x402ResourceServer(
    new BatchFacilitatorClient({
      url:
        env.ARC_CHAIN_ID === 5042002
          ? "https://gateway-api-testnet.circle.com"
          : "https://gateway-api.circle.com",
    }) as unknown as FacilitatorClient, // same interface; Circle bundles its own x402 types
  ).register(network, new GatewayEvmScheme() as unknown as ExactEvmScheme);

  const usdcPrice = (units: string) => ({
    amount: units,
    asset: env.USDC_ADDRESS,
    extra: { name: "USDC", version: "2" },
  });
  // The price the broken /v1/refuses route quotes.
  const price = usdcPrice("10000");

  /**
   * What this seller sells: small, fixed-price resources an agent making a short film might buy.
   * Prices are in micro-USDC; the catalog lists them, and each URL's 402 quote is authoritative.
   */
  const products = [
    {
      path: "/v1/insight",
      units: "10000",
      description: "One short insight line about AI agents and money",
      body: () => ({ insight: "Idle money earns nothing; unbounded agents spend everything." }),
    },
    {
      path: "/v1/script-line",
      units: "20000",
      description: "One line of script dialogue for a short explainer film",
      body: () => ({
        line: pick([
          "“We gave our agents a budget, not the company card.”",
          "“Every payment checked. The big ones, signed by a human.”",
          "“It can't spend what it wasn't given.”",
        ]),
      }),
    },
    {
      path: "/v1/stock-image",
      units: "50000",
      description: "A licensed stock image brief for one film scene",
      body: () => ({
        image: "Wide shot, dusk, a glass vault on a desk; three small robots queue in front of it.",
        licence: "demo-licence-0001",
      }),
    },
    {
      path: "/v1/market-report",
      units: "150000",
      description: "A short market report on AI agents that pay for services",
      body: () => ({
        report:
          "Agent spending is moving on-chain: per-task budgets, human approval above a threshold, and audit trails are becoming table stakes.",
      }),
    },
  ] as const;

  /** Sub-cent resources, sold only through Circle Gateway (too small to settle one by one). */
  const nanoProducts = [
    {
      path: "/v1/nano/sound-cue",
      units: "1000",
      description: "One sound cue for a film scene (nanopayment, Circle Gateway)",
      body: () => ({
        cue: pick([
          "Low synth swell under the vault reveal, 4 seconds.",
          "Soft keyboard clicks, office ambience, fade in.",
          "A single bright chime as the payment clears.",
        ]),
      }),
    },
    {
      path: "/v1/nano/caption",
      units: "2000",
      description: "One on-screen caption for a film scene (nanopayment, Circle Gateway)",
      body: () => ({
        caption: pick([
          "Every payment, checked.",
          "Budgets per job, not per company.",
          "Signed by a human above the line.",
        ]),
      }),
    },
  ] as const;

  /** Resources that take a JSON body, so the agent POSTs: Bursar quotes and pays them the same way. */
  const postProducts = [
    {
      path: "/v1/shot-list",
      units: "30000",
      description: 'A shot list for a scene you describe. POST {"scene": "..."}',
      body: (input: { scene?: unknown }) => {
        const scene = typeof input.scene === "string" ? input.scene.slice(0, 200) : "the scene";
        return {
          scene,
          shots: [
            `1. Wide establishing shot: ${scene}`,
            "2. Medium shot on the main subject, slow push-in.",
            "3. Close-up detail that carries the idea.",
          ],
        };
      },
    },
  ] as const;

  function pick<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)] as T;
  }

  const app = new Hono()
    // A storefront for people who open the address in a browser. Agents use the catalog below.
    .get("/", (c) =>
      c.html(storefront([...products, ...nanoProducts], postProducts, seller.address)),
    )
    .get("/health", (c) => c.json({ status: "ok", payTo: seller.address, network }))
    // The catalog agents read to learn what's for sale (prices come from each URL's 402 quote).
    .get("/.well-known/x402", (c) =>
      c.json({
        x402Version: 2,
        resources: [
          ...[...products, ...nanoProducts].map((p) => ({
            url: p.path,
            method: "GET",
            description: p.description,
          })),
          ...postProducts.map((p) => ({ url: p.path, method: "POST", description: p.description })),
        ],
      }),
    )
    // A deliberately broken seller for demos and tests: it quotes a price but refuses every
    // payment. Bursar must treat the money as unresolved and refund it once the signature expires.
    .get("/v1/refuses", (c) => {
      c.header(
        "PAYMENT-REQUIRED",
        encodePaymentRequiredHeader({
          x402Version: 2,
          resource: {
            url: c.req.url,
            description: "A seller that never accepts payment",
            mimeType: "application/json",
          },
          accepts: [
            {
              scheme: "exact",
              network,
              amount: price.amount,
              asset: price.asset,
              payTo: seller.address,
              maxTimeoutSeconds: 30,
              extra: price.extra,
            },
          ],
        }),
      );
      return c.json({ error: "This seller never accepts payment" }, 402);
    })
    .use(
      paymentMiddleware(
        Object.fromEntries(
          [
            ...products.map((p) => ({ route: `GET ${p.path}`, p })),
            ...postProducts.map((p) => ({ route: `POST ${p.path}`, p })),
          ].map(({ route, p }) => [
            route,
            {
              accepts: {
                scheme: "exact",
                network,
                payTo: seller.address,
                price: usdcPrice(p.units),
              },
              description: p.description,
              mimeType: "application/json",
            },
          ]),
        ),
        resourceServer,
      ),
    )
    .use(
      paymentMiddleware(
        Object.fromEntries(
          nanoProducts.map((p) => [
            `GET ${p.path}`,
            {
              accepts: {
                scheme: "exact",
                network,
                payTo: seller.address,
                price: `$${(Number(p.units) / 1e6).toFixed(6)}`,
              },
              description: p.description,
              mimeType: "application/json",
            },
          ]),
        ),
        gatewayServer,
      ),
    );
  for (const product of [...products, ...nanoProducts]) {
    app.get(product.path, (c) => c.json({ ...product.body(), servedAt: new Date().toISOString() }));
  }
  for (const product of postProducts) {
    app.post(product.path, async (c) => {
      const input = (await c.req.json().catch(() => ({}))) as { scene?: unknown };
      return c.json({ ...product.body(input), servedAt: new Date().toISOString() });
    });
  }
  return { app, payTo: seller.address, network };
}

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );

/** "0.01", or "0.001" for sub-cent prices. */
const formatPrice = (units: string) => {
  const value = Number(units) / 1e6;
  return value >= 0.01 ? value.toFixed(2) : String(value);
};

/** The human-readable front page: what's for sale, the price, and how agents buy it. */
function storefront(
  items: readonly { path: string; units: string; description: string }[],
  postItems: readonly { path: string; units: string; description: string }[],
  payTo: string,
): string {
  const rows = [
    ...items.map((p) => ({ method: "GET", ...p })),
    ...postItems.map((p) => ({ method: "POST", ...p })),
  ]
    .map(
      (p) =>
        `<tr><td><code>${p.method} ${escape(p.path)}</code></td><td>${escape(p.description)}</td><td class="price">${formatPrice(p.units)} USDC</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scenestock · film assets for agents</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--ink:#18181b;--muted:#71717a;--line:#e4e4e7;--gold:#b08a2e}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0d;--ink:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--gold:#ddb75a}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:56px 16px}
h1{font-size:40px;letter-spacing:-.02em;margin:8px 0}
.kicker{color:var(--gold);font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:600}
p{color:var(--muted)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;margin:28px 0}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:12px 16px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-weight:500;color:var(--muted)}
.price{white-space:nowrap;font-variant-numeric:tabular-nums}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--ink)}
</style></head>
<body><main>
<div class="kicker">x402 seller · Arc testnet</div>
<h1>Scenestock</h1>
<p>Film assets for AI agents: script lines, stock image briefs and market reports, paid per request in USDC with <a href="https://www.x402.org">x402</a>. Sub-cent items (sound cues, captions) are nanopayments through Circle Gateway: signed off-chain, settled on Arc in batches. Each URL answers <code>402 Payment Required</code> with its price; pay and it delivers.</p>
<div class="wrap"><table><thead><tr><th>Resource</th><th>What you get</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>Catalog for agents: <a href="/.well-known/x402"><code>/.well-known/x402</code></a>. Payments go to <code>${escape(payTo)}</code>, settled by Circle's facilitator on Arc testnet.</p>
<p>Scenestock is the seller in <a href="https://bursarhq.vercel.app/demo">Bursar's live demo</a>, where an AI operator buys from it within a job's budget.</p>
</main></body></html>`;
}
