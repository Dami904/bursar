import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GATEWAY_NETWORKS,
  PAID_CALL_TIMEOUT_MS,
  QuoteError,
  UnsafeUrlError,
  maxRequestBodyBytes,
  paidRequest,
  assertFetchable,
  isPrivateAddress,
  publicFetchOptions,
  quote,
  sendPayment,
  signPayment,
  type TypedDataSigner,
} from "../src/index.js";

const NETWORK = "eip155:5042002";
const USDC = "0x3600000000000000000000000000000000000000";
const PAY_TO = "0xc140E91475BfA94C0A7531d8A0CBc018aE1d277e";
const GATEWAY_WALLET = "0x0077777d7eba4688bdef3e311b846f25870a19b9";

/** A sub-cent option exactly as Circle's Gateway middleware offers it on Arc testnet. */
const nanoOption = {
  scheme: "exact",
  network: NETWORK as `${string}:${string}`,
  asset: USDC,
  amount: "1000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 604_900,
  extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_WALLET },
} satisfies PaymentRequired["accepts"][number];

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const signer: TypedDataSigner = {
  address: account.address,
  signTypedData: (m) => account.signTypedData(m as Parameters<typeof account.signTypedData>[0]),
};

function paymentRequired(
  overrides: Partial<PaymentRequired["accepts"][number]> = {},
): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: "http://seller/v1/insight",
      description: "test",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: "10000",
        asset: USDC,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
        ...overrides,
      },
    ],
  };
}

/** A tiny seller whose behaviour each test picks via the path. */
let server: Server;
let base = "";
/** What the POST-only /search route received on its last call. */
let seen:
  | { method?: string | undefined; contentType?: string | undefined; body: string; paid: boolean }
  | undefined;
beforeAll(async () => {
  server = createServer((req, res) => {
    const paid = req.headers["payment-signature"] !== undefined;
    if (req.url === "/search") {
      // A search seller: it only answers a POST with a JSON body, paid or not.
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen = {
          method: req.method,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
          paid,
        };
        if (req.method !== "POST" || seen.body === "") {
          res.writeHead(405);
          return res.end("POST a JSON body");
        }
        if (!paid) {
          res.writeHead(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()),
          });
          return res.end("{}");
        }
        res.writeHead(200, {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction: "0xabc",
            network: NETWORK,
            payer: account.address,
          }),
        });
        return res.end('{"results":["paid"]}');
      });
      return;
    }
    switch (req.url) {
      case "/insight":
        if (!paid) {
          res.writeHead(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()),
          });
          return res.end("{}");
        }
        res.writeHead(200, {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction: "0xabc",
            network: NETWORK,
            payer: account.address,
          }),
        });
        return res.end('{"insight":"paid"}');
      case "/wrong-network":
        res.writeHead(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(
            paymentRequired({ network: "eip155:8453" }),
          ),
        });
        return res.end("{}");
      case "/nano":
        res.writeHead(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            ...paymentRequired(),
            accepts: [nanoOption],
          }),
        });
        return res.end("{}");
      case "/both": {
        const both = paymentRequired();
        res.writeHead(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            ...both,
            accepts: [nanoOption, ...both.accepts],
          }),
        });
        return res.end("{}");
      }
      case "/both-dear": {
        // Both rails at 2 cents: worth a plain on-chain payment.
        const both = paymentRequired({ amount: "20000" });
        res.writeHead(402, {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            ...both,
            accepts: [{ ...nanoOption, amount: "20000" }, ...both.accepts],
          }),
        });
        return res.end("{}");
      }
      case "/slow": {
        // A seller that takes its time, like one generating an image.
        if (!paid) {
          res.writeHead(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()),
          });
          return res.end("{}");
        }
        setTimeout(() => {
          res.writeHead(200, {
            "PAYMENT-RESPONSE": encodePaymentResponseHeader({
              success: true,
              transaction: "0xabc",
              network: NETWORK,
              payer: account.address,
            }),
          });
          res.end('{"image":"done"}');
        }, 400);
        return;
      }
      case "/accepted":
        // An asynchronous seller: takes the payment, answers "working on it", no receipt yet.
        if (!paid) {
          res.writeHead(402, {
            "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()),
          });
          return res.end("{}");
        }
        res.writeHead(202, { "content-type": "application/json" });
        return res.end('{"id":"job-42","status":"processing"}');
      case "/free":
        res.writeHead(200);
        return res.end("free");
      case "/redirect":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        return res.end();
      case "/refuse":
        res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()) });
        return res.end('{"error":"invalid signature"}');
      case "/bad-request":
        res.writeHead(400, { "content-type": "application/json" });
        return res.end('{"error":"model is required\nsize is optional"}');
      case "/crash":
        res.writeHead(502);
        return res.end("bad gateway");
      default:
        res.writeHead(404);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const options = { network: NETWORK, asset: USDC, allowPrivateHosts: true };

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    // IPv4 written as IPv6, the way the URL parser normalises it: loopback and cloud metadata.
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "fe90::1",
    "198.51.100.7",
    "not-an-address",
  ])("treats %s as private", (address) => expect(isPrivateAddress(address)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("treats %s as public", (address) =>
    expect(isPrivateAddress(address)).toBe(false),
  );

  it("refuses loopback, metadata and non-http URLs unless private hosts are allowed", async () => {
    await expect(assertFetchable("http://127.0.0.1:4021/x", false)).rejects.toThrow(UnsafeUrlError);
    await expect(assertFetchable("http://169.254.169.254/latest", false)).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(assertFetchable("file:///etc/passwd", true)).rejects.toThrow(UnsafeUrlError);
    await expect(assertFetchable("http://user:pw@example.com/", true)).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(assertFetchable("http://127.0.0.1:4021/x", true)).resolves.toBeInstanceOf(URL);
  });

  it("refuses internal addresses however the URL spells them", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]:8787/health",
      "http://[::ffff:169.254.169.254]/latest/meta-data",
      "http://[::127.0.0.1]/",
      "http://0x7f.1/",
      "http://2130706433/",
    ]) {
      await expect(assertFetchable(url, false), url).rejects.toThrow(UnsafeUrlError);
    }
  });

  it("checks the address again when connecting, so a name can't rebind to an internal one", async () => {
    // `localhost` stands in for a seller whose DNS answer changed after the check.
    const internal = createServer((_req, res) => res.end("internal"));
    await new Promise<void>((resolve) => internal.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(internal.address() as AddressInfo).port}/`;
    try {
      expect(await (await fetch(url, publicFetchOptions(true))).text()).toBe("internal");
      await expect(fetch(url, publicFetchOptions(false))).rejects.toThrow();
    } finally {
      internal.close();
    }
  });
});

describe("quote", () => {
  it("reads the price and payee from the 402 challenge", async () => {
    const q = await quote(`${base}/insight`, options);
    expect(q.amount).toBe(10_000n);
    expect(q.payTo).toBe(PAY_TO);
    expect(q.requirements.network).toBe(NETWORK);
  });

  it("takes Circle Gateway when that's all a sub-cent seller offers", async () => {
    const q = await quote(`${base}/nano`, options);
    expect(q.rail).toBe("GATEWAY");
    expect(q.amount).toBe(1_000n);
  });

  it("pays an item under a cent through Gateway when the seller offers both", async () => {
    // Gas for a plain on-chain payment would cost about as much as the item.
    const q = await quote(`${base}/both`, options);
    expect(q.rail).toBe("GATEWAY");
    expect(q.amount).toBe(1_000n);
  });

  it("prefers a plain on-chain payment from a cent up, or when that's all a seller takes", async () => {
    const q = await quote(`${base}/both-dear`, options);
    expect(q.rail).toBe("VAULT");
    expect(q.amount).toBe(20_000n);
    expect((await quote(`${base}/insight`, options)).rail).toBe("VAULT");
  });

  it("takes the threshold from the options", async () => {
    const q = await quote(`${base}/both`, { ...options, gatewayBelow: 1_000n });
    expect(q.rail).toBe("VAULT"); // 0.001 isn't below 0.001
  });

  it("refuses a seller that doesn't take USDC on our network", async () => {
    await expect(quote(`${base}/wrong-network`, options)).rejects.toThrow(/doesn't accept USDC/);
  });

  it("refuses a resource that isn't paywalled, and redirects", async () => {
    await expect(quote(`${base}/free`, options)).rejects.toThrow(QuoteError);
    await expect(quote(`${base}/redirect`, options)).rejects.toThrow(/got HTTP 302/);
  });

  it("refuses private hosts when they're not allowed", async () => {
    await expect(
      quote(`${base}/insight`, { ...options, allowPrivateHosts: false }),
    ).rejects.toThrow(UnsafeUrlError);
  });
});

describe("Arc mainnet", () => {
  it("knows Circle Gateway's mainnet contracts and API", () => {
    expect(GATEWAY_NETWORKS["eip155:5042"]).toEqual({
      gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
      gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
      domain: 26,
      apiUrl: "https://gateway-api.circle.com/v1",
    });
  });
});

describe("POST sellers", () => {
  const request = paidRequest("POST", { query: "agent budgets", numResults: 2 });

  it("quotes with the same method and JSON body the paid call will use", async () => {
    const q = await quote(`${base}/search`, options, request);
    expect(q.amount).toBe(10_000n);
    expect(q.request).toEqual(request);
    expect(seen).toMatchObject({
      method: "POST",
      contentType: "application/json",
      body: '{"query":"agent budgets","numResults":2}',
      paid: false,
    });
  });

  it("pays with the same method and body, and the seller delivers", async () => {
    const outcome = await sendPayment(`${base}/search`, "e30=", { request });
    expect(outcome).toMatchObject({ kind: "PAID", body: '{"results":["paid"]}' });
    expect(seen).toMatchObject({ method: "POST", paid: true, body: request.body });
  });

  it("a GET quote of a POST-only seller is refused, as before", async () => {
    await expect(quote(`${base}/search`, options)).rejects.toThrow(/got HTTP 405/);
  });

  it("builds only valid requests", () => {
    expect(paidRequest("GET", undefined)).toEqual({ method: "GET" });
    expect(paidRequest("POST", undefined)).toEqual({ method: "POST" });
    expect(() => paidRequest("GET", { a: 1 })).toThrow(QuoteError);
    expect(() => paidRequest("POST", { text: "x".repeat(maxRequestBodyBytes) })).toThrow(
      /at most 4096 bytes/,
    );
  });
});

describe("signPayment", () => {
  it("signs an EIP-3009 authorization for exactly the quoted amount and payee", async () => {
    const q = await quote(`${base}/insight`, options);
    const signed = await signPayment(signer, q.paymentRequired, q.requirements);
    expect(signed.payer).toBe(account.address);
    expect(signed.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.validBefore.getTime()).toBeGreaterThan(Date.now());

    const decoded = JSON.parse(Buffer.from(signed.header, "base64").toString()) as {
      payload: { signature: Hex; authorization: Record<string, string> };
    };
    const auth = decoded.payload.authorization;
    expect(auth.to).toBe(PAY_TO);
    expect(auth.value).toBe("10000");
    const recovered = await recoverTypedDataAddress({
      domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as Hex,
        to: auth.to as Hex,
        value: BigInt(auth.value!),
        validAfter: BigInt(auth.validAfter!),
        validBefore: BigInt(auth.validBefore!),
        nonce: auth.nonce as Hex,
      },
      signature: decoded.payload.signature,
    });
    expect(recovered).toBe(account.address);
  });

  it("signs Gateway payments against Circle's GatewayWallet, not the USDC contract", async () => {
    const q = await quote(`${base}/nano`, options);
    const signed = await signPayment(signer, q.paymentRequired, q.requirements);
    const decoded = JSON.parse(Buffer.from(signed.header, "base64").toString()) as {
      accepted: { extra: { name: string } };
      payload: { signature: Hex; authorization: Record<string, string> };
    };
    expect(decoded.accepted.extra.name).toBe("GatewayWalletBatched");
    const auth = decoded.payload.authorization;
    expect(auth.to).toBe(PAY_TO);
    expect(auth.value).toBe("1000");
    // Circle requires at least a week of validity on batched authorizations.
    expect(Number(auth.validBefore) - Date.now() / 1000).toBeGreaterThan(604_000);
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "GatewayWalletBatched",
        version: "1",
        chainId: 5042002,
        verifyingContract: GATEWAY_WALLET,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as Hex,
        to: auth.to as Hex,
        value: BigInt(auth.value!),
        validAfter: BigInt(auth.validAfter!),
        validBefore: BigInt(auth.validBefore!),
        nonce: auth.nonce as Hex,
      },
      signature: decoded.payload.signature,
    });
    expect(recovered).toBe(account.address);
    expect(signed.payer).toBe(account.address);
  });

  it("uses a fresh nonce every time", async () => {
    const q = await quote(`${base}/insight`, options);
    const a = await signPayment(signer, q.paymentRequired, q.requirements);
    const b = await signPayment(signer, q.paymentRequired, q.requirements);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("sendPayment: three outcomes, never two", () => {
  it("PAID when the seller delivers with a settlement receipt", async () => {
    const outcome = await sendPayment(`${base}/insight`, "e30=");
    expect(outcome).toMatchObject({ kind: "PAID", body: '{"insight":"paid"}' });
  });

  it("REFUSED when the seller positively rejects the payment", async () => {
    expect((await sendPayment(`${base}/refuse`, "e30=")).kind).toBe("REFUSED");
  });

  it("UNKNOWN on a 5xx: money may have moved", async () => {
    expect((await sendPayment(`${base}/crash`, "e30=")).kind).toBe("UNKNOWN");
  });

  it("waits for a slow seller well past a page load: a minute or two by default", async () => {
    expect(PAID_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    const outcome = await sendPayment(`${base}/slow`, "e30=", { timeoutMs: 5_000 });
    expect(outcome).toMatchObject({ kind: "PAID", body: '{"image":"done"}' });
  });

  it("UNKNOWN when the seller takes longer than the wait: money may have moved", async () => {
    expect((await sendPayment(`${base}/slow`, "e30=", { timeoutMs: 100 })).kind).toBe("UNKNOWN");
  });

  it("UNKNOWN for a 202 without a receipt, keeping what it said (the job id)", async () => {
    expect(await sendPayment(`${base}/accepted`, "e30=")).toEqual({
      kind: "UNKNOWN",
      reason: "HTTP 202 without a settlement receipt",
      body: '{"id":"job-42","status":"processing"}',
    });
  });

  it("UNKNOWN when nothing answers", async () => {
    expect((await sendPayment("http://127.0.0.1:1/nothing", "e30=")).kind).toBe("UNKNOWN");
  });

  it("a failed quote carries what the seller said, so a bad request can be corrected", async () => {
    const error = await quote(`${base}/bad-request`, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuoteError);
    expect((error as Error).message).toContain("got HTTP 400");
    expect((error as Error).message).toContain("model is required size is optional");
  });
});
