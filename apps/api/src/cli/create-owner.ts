import { fileURLToPath } from "node:url";
import { createDb } from "@bursar/db";
import { createOwner } from "../services/owners.js";

process.loadEnvFile(fileURLToPath(new URL("../../../../.env", import.meta.url)));
const url = process.env.DATABASE_URL;
const name = process.argv[2];
if (url === undefined) throw new Error("DATABASE_URL is not set");
if (name === undefined || name.trim() === "") {
  process.stderr.write('Usage: pnpm --filter @bursar/api owner:create "Business name"\n');
  process.exit(1);
}

const { db, client } = createDb(url, { max: 1 });
const { owner, key } = await createOwner(db, name.trim());
await client.end();
process.stdout.write(
  `Owner created: ${owner.id} (${owner.name})\nOwner key (shown once, store it safely):\n${key}\n`,
);
