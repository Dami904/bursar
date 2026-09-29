import { handle } from "hono/vercel";
import { createSellerApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

/** The seller as one Vercel function; vercel.json sends every path here. */
const { app } = createSellerApp(loadEnv(process.env));

export const GET = handle(app);
export const POST = handle(app);
