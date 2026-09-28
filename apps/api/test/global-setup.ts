import { fileURLToPath } from "node:url";
import postgres from "postgres";
// Imported by path: vitest global setup does not apply the workspace source condition.
import { runMigrations } from "../../../packages/db/src/migrate.js";

export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL === undefined) {
    try {
      process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
    } catch {
      // CI sets TEST_DATABASE_URL directly.
    }
  }
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) {
    throw new Error("TEST_DATABASE_URL is not set. Run `docker compose up -d` and check .env");
  }
  if (!/_test\b/.test(new URL(url).pathname)) {
    throw new Error("Refusing to run tests against a database whose name doesn't end in _test");
  }
  return url;
}

/** Rebuilds the test database from the migrations before the run. */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  await sql.unsafe(
    "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;",
  );
  await sql.end();
  await runMigrations(url);
}
