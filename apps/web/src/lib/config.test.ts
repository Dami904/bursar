import { afterEach, describe, expect, it, vi } from "vitest";

/** config.ts reads the build's VITE_* values once, so each case loads a fresh copy. */
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return (await import("./config.js")).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("which Arc network the console is built for", () => {
  it("is testnet unless the build says mainnet", async () => {
    const config = await load({});
    expect(config).toMatchObject({ mainnet: false, explorer: "https://explorer.testnet.arc.io" });
    expect(config.chain.id).toBe(5042002);
    expect(config.vault).toBe("0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6");
  });

  it("is mainnet with chain 5042, its explorer and its own vault", async () => {
    const vault = "0x1111111111111111111111111111111111111111";
    const config = await load({ VITE_ARC_CHAIN_ID: "5042", VITE_JOB_VAULT_ADDRESS: vault });
    expect(config).toMatchObject({ mainnet: true, explorer: "https://explorer.arc.io", vault });
    expect(config.chain.id).toBe(5042);
  });

  it("refuses a mainnet build without a vault address, rather than using testnet's", async () => {
    await expect(load({ VITE_ARC_CHAIN_ID: "5042" })).rejects.toThrow(/VITE_JOB_VAULT_ADDRESS/);
  });
});
