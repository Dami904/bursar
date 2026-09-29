import { serve } from "@hono/node-server";
import { createSellerApp } from "./app.js";
import { loadEnv } from "./env.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file: rely on the process environment.
}
const env = loadEnv(process.env);
const { app, payTo, network } = createSellerApp(env);

serve({ fetch: app.fetch, port: env.SELLER_PORT, hostname: env.HOST }, (info) => {
  process.stdout.write(
    `Seller listening on http://${env.HOST}:${info.port} (payTo ${payTo}, ${network})
`,
  );
});
