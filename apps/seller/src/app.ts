import { encodePaymentRequiredHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
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

  function pick<T>(items: readonly T[]): T {
    return items[Math.floor(Math.random() * items.length)] as T;
  }

  const app = new Hono()
    .get("/health", (c) => c.json({ status: "ok", payTo: seller.address, network }))
    // The catalog agents read to learn what's for sale (prices come from each URL's 402 quote).
    .get("/.well-known/x402", (c) =>
      c.json({
        x402Version: 2,
        resources: products.map((p) => ({
          url: p.path,
          method: "GET",
          description: p.description,
        })),
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
          products.map((p) => [
            `GET ${p.path}`,
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
    );
  for (const product of products) {
    app.get(product.path, (c) => c.json({ ...product.body(), servedAt: new Date().toISOString() }));
  }
  return { app, payTo: seller.address, network };
}
