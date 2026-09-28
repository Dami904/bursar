/**
 * One-time setup: generates a Circle entity secret, stores it in the repo's .env, and registers it
 * with Circle using CIRCLE_API_KEY. Circle returns a recovery file, saved OUTSIDE the repo; it's the
 * only way to reset the secret if it's ever lost.
 *
 *   pnpm --filter @bursar/worker circle:register-entity-secret
 *
 * Refuses to run if CIRCLE_ENTITY_SECRET is already set: a second secret would orphan the first.
 * Never prints the secret.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
const recoveryDir = join(homedir(), ".bursar", "circle-recovery");

function readEnv(): string {
  return readFileSync(envPath, "utf8");
}

function valueOf(env: string, name: string): string {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(env);
  return (match?.[1] ?? "").trim().replace(/^"|"$/g, "");
}

function setValue(env: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  return new RegExp(`^${name}=.*$`, "m").test(env)
    ? env.replace(new RegExp(`^${name}=.*$`, "m"), line)
    : `${env.trimEnd()}\n${line}\n`;
}

const env = readEnv();
const apiKey = valueOf(env, "CIRCLE_API_KEY");
if (!apiKey.startsWith("TEST_API_KEY:")) {
  throw new Error("CIRCLE_API_KEY must be a Circle testnet key (TEST_API_KEY:...)");
}
if (valueOf(env, "CIRCLE_ENTITY_SECRET") !== "") {
  throw new Error("CIRCLE_ENTITY_SECRET is already set. Refusing to replace a registered secret.");
}

// Persist first: if registration succeeds and anything after it fails, the secret isn't lost.
const entitySecret = randomBytes(32).toString("hex");
writeFileSync(envPath, setValue(env, "CIRCLE_ENTITY_SECRET", entitySecret));

try {
  mkdirSync(recoveryDir, { recursive: true });
  const response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    recoveryFileDownloadPath: recoveryDir,
  });
  const recoveryFile = response.data?.recoveryFile;
  if (recoveryFile !== undefined) {
    const path = join(
      recoveryDir,
      `bursar-circle-recovery-${new Date().toISOString().replaceAll(":", "-")}.dat`,
    );
    writeFileSync(path, recoveryFile, { mode: 0o600 });
    process.stdout.write(`Recovery file saved: ${path}\n`);
  }
  process.stdout.write("Entity secret generated, saved to .env and registered with Circle.\n");
} catch (error) {
  // Registration failed: remove the unregistered secret so the script can be re-run cleanly.
  writeFileSync(envPath, setValue(readEnv(), "CIRCLE_ENTITY_SECRET", ""));
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Registration failed; .env left without a secret. ${message}\n`);
  process.exit(1);
}
