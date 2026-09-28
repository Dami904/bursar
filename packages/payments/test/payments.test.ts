import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  QuoteError,
  UnsafeUrlError,
  assertFetchable,
  isPrivateAddress,
  quote,
  sendPayment,
  signPayment,
  type TypedDataSigner,
} from "../src/index.js";

const NETWORK = "eip155:5042002";
const USDC = "0x3600000000000000000000000000000000000000";
const PAY_TO = "0xc140E91475BfA94C0A7531d8A0CBc018aE1d277e";

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
beforeAll(async () => {
  server = createServer((req, res) => {
    const paid = req.headers["payment-signature"] !== undefined;
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
      case "/free":
        res.writeHead(200);
        return res.end("free");
      case "/redirect":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
        return res.end();
      case "/refuse":
        res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired()) });
        return res.end('{"error":"invalid signature"}');
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
});

describe("quote", () => {
  it("reads the price and payee from the 402 challenge", async () => {
    const q = await quote(`${base}/insight`, options);
    expect(q.amount).toBe(10_000n);
    expect(q.payTo).toBe(PAY_TO);
    expect(q.requirements.network).toBe(NETWORK);
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

  it("UNKNOWN when nothing answers", async () => {
    expect((await sendPayment("http://127.0.0.1:1/nothing", "e30=")).kind).toBe("UNKNOWN");
  });
});
