import { jobVaultAbi, usdcAbi } from "@bursar/payments/chain";
import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { buildSetupBatch, delegatedTo, supportsAtomicBatch, type OnChainParams } from "./batch.js";

const VAULT = `0x${"11".repeat(20)}` as Hex;
const USDC = `0x${"22".repeat(20)}` as Hex;
const OWNER = `0x${"33".repeat(20)}` as Hex;
const VENDOR = `0x${"44".repeat(20)}` as Hex;
const JOB = `0x${"ab".repeat(32)}` as Hex;
const params: OnChainParams = {
  agentWallet: `0x${"55".repeat(20)}` as Hex,
  budget: 5_000_000n,
  perTxCap: 5_000_000n,
  approvalThreshold: 1_000_000n,
  windowCap: 5_000_000n,
  window: 3600n,
  expiry: 1_800_000_000n,
};
const build = (over: Partial<Parameters<typeof buildSetupBatch>[0]> = {}) =>
  buildSetupBatch({
    vault: VAULT,
    usdc: USDC,
    vaultJobId: JOB,
    params,
    allowance: 0n,
    owner: OWNER,
    registerApprover: false,
    vendors: [],
    ...over,
  });
const names = (calls: ReturnType<typeof build>) =>
  calls.map((c) =>
    c.to === USDC
      ? decodeFunctionData({ abi: usdcAbi, data: c.data }).functionName
      : decodeFunctionData({ abi: jobVaultAbi, data: c.data }).functionName,
  );

describe("does the wallet offer all-or-nothing bundles", () => {
  it("says yes only when it reports atomic support on this chain", () => {
    expect(supportsAtomicBatch({ 5042: { atomic: { status: "supported" } } }, 5042)).toBe(true);
    expect(supportsAtomicBatch({ 5042: { atomic: { status: "ready" } } }, 5042)).toBe(true);
    expect(supportsAtomicBatch({ 5042: { atomic: { status: "unsupported" } } }, 5042)).toBe(false);
    expect(supportsAtomicBatch({ 1: { atomic: { status: "supported" } } }, 5042)).toBe(false);
    expect(supportsAtomicBatch({ 5042: {} }, 5042)).toBe(false);
    expect(supportsAtomicBatch({}, 5042)).toBe(false);
    expect(supportsAtomicBatch(undefined, 5042)).toBe(false);
    expect(supportsAtomicBatch(null, 5042)).toBe(false);
  });
});

describe("the setup bundle", () => {
  it("is open, allow, deposit when nothing is allowed yet", () => {
    expect(names(build())).toEqual(["createJob", "approve", "fund"]);
  });

  it("allows exactly the budget, never more", () => {
    const approves = build().filter((c) => c.to === USDC);
    expect(approves).toHaveLength(1);
    const [approve] = approves.map((c) => decodeFunctionData({ abi: usdcAbi, data: c.data }));
    expect(approve?.args).toEqual([VAULT, 5_000_000n]);
  });

  it("skips the allow call when the wallet already allows the budget or more", () => {
    expect(names(build({ allowance: 5_000_000n }))).toEqual(["createJob", "fund"]);
    expect(names(build({ allowance: 9_000_000n }))).toEqual(["createJob", "fund"]);
    expect(names(build({ allowance: 4_999_999n }))).toEqual(["createJob", "approve", "fund"]);
  });

  it("registers the owner as approver only when a payment can need approval", () => {
    expect(names(build({ registerApprover: true }))).toEqual([
      "createJob",
      "approve",
      "fund",
      "setApprover",
    ]);
    const call = build({ registerApprover: true }).at(-1);
    expect(decodeFunctionData({ abi: jobVaultAbi, data: call?.data ?? "0x" }).args).toEqual([
      JOB,
      OWNER,
      true,
    ]);
  });

  it("allows each vendor address last, and only those", () => {
    const calls = build({ vendors: [VENDOR] });
    expect(names(calls)).toEqual(["createJob", "approve", "fund", "setPayee"]);
    expect(decodeFunctionData({ abi: jobVaultAbi, data: calls.at(-1)?.data ?? "0x" }).args).toEqual(
      [JOB, VENDOR, true],
    );
  });

  it("only ever touches the vault and the USDC contract", () => {
    for (const call of build({ registerApprover: true, vendors: [VENDOR] })) {
      expect([VAULT, USDC]).toContain(call.to);
    }
  });
});

describe("an upgraded address", () => {
  it("is recognised by its delegation code, and a plain address is not", () => {
    const delegate = "ab".repeat(20);
    expect(delegatedTo(`0xef0100${delegate}` as Hex)).toBe(`0x${delegate}`);
    expect(delegatedTo("0x")).toBeNull();
    expect(delegatedTo(undefined)).toBeNull();
    expect(delegatedTo("0x6080604052" as Hex)).toBeNull();
  });
});
