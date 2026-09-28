import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");

const schema = z.object({
  ARC_CHAIN_ID: z.coerce.number().int().positive(),
  USDC_ADDRESS: address,
  SELLER_ADDRESS: address,
  SELLER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key"),
  SELLER_PORT: z.coerce.number().int().positive().default(4021),
  HOST: z.string().default("127.0.0.1"),
});

export type SellerEnv = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv): SellerEnv {
  return schema.parse(source);
}
