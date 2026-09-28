import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const { db, client } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
  const url = process.env.DATABASE_URL;
  if (url === undefined) throw new Error("DATABASE_URL is not set");
  await runMigrations(url);
  process.stdout.write("Migrations applied\n");
}
