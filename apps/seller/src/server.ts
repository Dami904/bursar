import { serve } from "@hono/node-server";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/hono";
import { Hono } from "hono";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CircleFacilitatorClient } from "./circle-facilitator.js";
import { loadEnv } from "./env.js";

process.loadEnvFile(new URL("../../../.env", import.meta.url));
const env = loadEnv(process.env);

const seller = privateKeyToAccount(env.SELLER_PRIVATE_KEY as `0x${string}`);
if (getAddress(seller.address) !== getAddress(env.SELLER_ADDRESS)) {
  throw new Error("SELLER_PRIVATE_KEY does not control SELLER_ADDRESS");
}

const network = `eip155:${env.ARC_CHAIN_ID}` as const;
const facilitator = new CircleFacilitatorClient({ seller, network });
const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

// One paid route for the day-2 spike: 0.01 USDC per call.
const price = {
  amount: "10000",
  asset: env.USDC_ADDRESS,
  extra: { name: "USDC", version: "2" },
};

const app = new Hono()
  .get("/health", (c) => c.json({ status: "ok", payTo: seller.address, network }))
  // The catalog agents read to learn what's for sale (prices come from each URL's 402 quote).
  .get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 2,
      resources: [
        {
          url: "/v1/insight",
          method: "GET",
          description: "One short insight line about AI agents and money",
        },
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
      {
        "GET /v1/insight": {
          accepts: { scheme: "exact", network, payTo: seller.address, price },
          description: "One short insight line about AI agents and money",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  )
  .get("/v1/insight", (c) =>
    c.json({
      insight: "Idle money earns nothing; unbounded agents spend everything.",
      servedAt: new Date().toISOString(),
    }),
  );

serve({ fetch: app.fetch, port: env.SELLER_PORT, hostname: env.HOST }, (info) => {
  process.stdout.write(
    `Seller listening on http://${env.HOST}:${info.port} (payTo ${seller.address}, ${network})\n`,
  );
});
