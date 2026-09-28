import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { JobWallet, WalletProvider } from "@bursar/payments";
import { jobVaultAbi, usdcAbi } from "@bursar/payments";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseSignature,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

/** Anvil's well-known development mnemonic: these keys only ever hold test money on a local chain. */
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });

export const accounts = {
  owner: account(0),
  operator: account(1),
  facilitator: account(2),
  approver: account(3),
  jobWallet: account(4),
  seller: account(5),
};

function artifact(path: string): { abi: unknown[]; bytecode: Hex } {
  const json = JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../contracts/out/${path}`, import.meta.url)), "utf8"),
  ) as { abi: unknown[]; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

export interface Chainside {
  readonly client: PublicClient;
  readonly wallet: (who: Account) => WalletClient<Transport, Chain, Account>;
  readonly operator: WalletClient<Transport, Chain, Account>;
  readonly usdc: Hex;
  readonly vault: Hex;
  /** AuditAnchor, operated by the same operator key as the vault. */
  readonly anchor: Hex;
  readonly deployBlock: bigint;
  readonly rpcUrl: string;
  increaseTime(seconds: number): Promise<void>;
  setAutomine(on: boolean): Promise<void>;
  mine(): Promise<void>;
  balanceOf(address: Hex): Promise<bigint>;
  mint(to: Hex, amount: bigint): Promise<void>;
  stop(): void;
}

/** Starts Anvil on a free port and deploys the real JobVault plus an EIP-3009 USDC stand-in. */
export async function startChain(): Promise<Chainside> {
  const port = 18_000 + Math.floor(Math.random() * 2_000);
  const anvil: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const transport = http(rpcUrl);
  const client = createPublicClient({ chain: foundry, transport, cacheTime: 0 }) as PublicClient;
  for (let i = 0; i < 100; i += 1) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const wallet = (who: Account) => createWalletClient({ chain: foundry, transport, account: who });
  const deployer = wallet(accounts.owner);

  const token = artifact("MockUSDC3009.sol/MockUSDC3009.json");
  const tokenHash = await deployer.deployContract({ abi: token.abi, bytecode: token.bytecode });
  const usdc = (await client.waitForTransactionReceipt({ hash: tokenHash })).contractAddress as Hex;
  const vaultArtifact = artifact("JobVault.sol/JobVault.json");
  const vaultHash = await deployer.deployContract({
    abi: vaultArtifact.abi,
    bytecode: vaultArtifact.bytecode,
    args: [usdc, accounts.operator.address],
  });
  const vaultReceipt = await client.waitForTransactionReceipt({ hash: vaultHash });
  const anchorArtifact = artifact("AuditAnchor.sol/AuditAnchor.json");
  const anchorHash = await deployer.deployContract({
    abi: anchorArtifact.abi,
    bytecode: anchorArtifact.bytecode,
    args: [accounts.operator.address],
  });
  const anchor = (await client.waitForTransactionReceipt({ hash: anchorHash }))
    .contractAddress as Hex;
  const mintHash = await deployer.writeContract({
    address: usdc,
    abi: tokenAbi,
    functionName: "mint",
    args: [accounts.owner.address, 1_000_000_000n],
  });
  await client.waitForTransactionReceipt({ hash: mintHash });

  const rpc = (method: string, params: unknown[] = []) =>
    client.request({ method: method as never, params: params as never });
  return {
    client,
    wallet,
    operator: wallet(accounts.operator),
    usdc,
    vault: vaultReceipt.contractAddress as Hex,
    anchor,
    deployBlock: vaultReceipt.blockNumber,
    rpcUrl,
    async increaseTime(seconds) {
      await rpc("evm_increaseTime", [seconds]);
      await rpc("evm_mine");
    },
    async setAutomine(on) {
      await rpc("evm_setAutomine", [on]);
    },
    async mine() {
      await rpc("evm_mine");
    },
    async mint(to, amount) {
      const hash = await deployer.writeContract({
        address: usdc,
        abi: tokenAbi,
        functionName: "mint",
        args: [to, amount],
      });
      await client.waitForTransactionReceipt({ hash });
    },
    balanceOf: (address) =>
      client.readContract({
        address: usdc,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address],
      }),
    stop() {
      anvil.kill();
    },
  };
}

/** Owner creates and funds a vault job, exactly as the browser (or onchain:job) would. */
export async function openVaultJob(
  chain: Chainside,
  vaultJobId: Hex,
  params: { budget: bigint; perTxCap: bigint; threshold: bigint; windowCap?: bigint; fund: bigint },
) {
  const owner = chain.wallet(accounts.owner);
  const block = await chain.client.getBlock();
  const send = async (hash: Promise<Hex>) =>
    chain.client.waitForTransactionReceipt({ hash: await hash });
  await send(
    owner.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "createJob",
      args: [
        vaultJobId,
        {
          agentWallet: accounts.jobWallet.address,
          budget: params.budget,
          perTxCap: params.perTxCap,
          approvalThreshold: params.threshold,
          windowCap: params.windowCap ?? params.budget,
          window: 3600n,
          expiry: block.timestamp + 7n * 86_400n,
        },
      ],
    }),
  );
  await send(
    owner.writeContract({
      address: chain.usdc,
      abi: usdcAbi,
      functionName: "approve",
      args: [chain.vault, params.fund],
    }),
  );
  await send(
    owner.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "fund",
      args: [vaultJobId, params.fund],
    }),
  );
}

/** A job wallet backed by a local Anvil key instead of Circle. */
export function localWallets(chain: Chainside): WalletProvider {
  const signerAccount = accounts.jobWallet;
  const transfers = new Map<string, Hex>();
  return {
    async createJobWallet(): Promise<JobWallet> {
      return { id: "local-job-wallet", address: signerAccount.address };
    },
    signer() {
      return {
        address: signerAccount.address,
        signTypedData: (m) =>
          signerAccount.signTypedData(m as Parameters<typeof signerAccount.signTypedData>[0]),
      };
    },
    async transfer(request) {
      const existing = transfers.get(request.idempotencyKey);
      if (existing !== undefined) return { id: existing };
      const hash = await chain.wallet(signerAccount).writeContract({
        address: request.token,
        abi: usdcAbi,
        functionName: "transfer",
        args: [request.to, request.amount],
      });
      await chain.client.waitForTransactionReceipt({ hash });
      transfers.set(request.idempotencyKey, hash);
      return { id: hash };
    },
    async transferStatus(id) {
      const receipt = await chain.client.getTransactionReceipt({ hash: id as Hex });
      return { state: receipt.status === "success" ? "COMPLETE" : "FAILED", txHash: id };
    },
  };
}

export type SellerMode = "normal" | "refuse" | "settle-then-crash";

export interface LocalSeller {
  readonly url: string;
  mode: SellerMode;
  stop(): void;
}

/**
 * An x402 seller that settles on the local chain itself, as Circle's Facilitator does on Arc.
 * `mode` makes it misbehave: refuse every payment, or settle and then answer 502.
 */
export async function startSeller(
  chain: Chainside,
  price = 100_000n,
  timeoutSeconds = 60,
): Promise<LocalSeller> {
  const facilitator = chain.wallet(accounts.facilitator);
  let url = "";
  const state: { mode: SellerMode } = { mode: "normal" };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const header = req.headers["payment-signature"];
      const requirements = {
        scheme: "exact",
        network: `eip155:${chain.client.chain?.id ?? 31337}` as `${string}:${string}`,
        amount: price.toString(),
        asset: chain.usdc,
        payTo: accounts.seller.address,
        maxTimeoutSeconds: timeoutSeconds,
        extra: { name: "USDC", version: "2" },
      };
      if (typeof header !== "string" || state.mode === "refuse") {
        res.writeHead(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            x402Version: 2,
            resource: {
              url: `${url}${req.url}`,
              description: "test",
              mimeType: "application/json",
            },
            accepts: [requirements],
          }),
        });
        return res.end("{}");
      }
      const payment = decodePaymentSignatureHeader(header);
      const auth = (payment.payload as { authorization: Record<string, string> }).authorization;
      const signature = parseSignature((payment.payload as { signature: Hex }).signature);
      const hash = await facilitator.writeContract({
        address: chain.usdc,
        abi: tokenAbi,
        functionName: "transferWithAuthorization",
        args: [
          auth.from as Hex,
          auth.to as Hex,
          BigInt(auth.value!),
          BigInt(auth.validAfter!),
          BigInt(auth.validBefore!),
          auth.nonce as Hex,
          Number(signature.v ?? BigInt(signature.yParity + 27)),
          signature.r,
          signature.s,
        ],
      });
      await chain.client.waitForTransactionReceipt({ hash });
      if (state.mode === "settle-then-crash") {
        res.writeHead(502);
        return res.end("bad gateway");
      }
      res.writeHead(200, {
        "PAYMENT-RESPONSE": encodePaymentResponseHeader({
          success: true,
          transaction: hash,
          network: requirements.network,
          payer: auth.from!,
        }),
      });
      res.end('{"insight":"paid"}');
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get mode() {
      return state.mode;
    },
    set mode(mode: SellerMode) {
      state.mode = mode;
    },
    stop: () => server.close(),
  };
}
