import { describe, expect, it } from "vitest";
import {
  MAX_UINT128,
  MoneyError,
  assertContractAmount,
  formatUsdc,
  nativeToUsdcExact,
  nativeToUsdcFloor,
  parseUsdc,
  sumUsdc,
  usdcFromJson,
  usdcToJson,
  usdcToNative,
} from "../src/index.js";

describe("parseUsdc", () => {
  it.each([
    ["0", 0n],
    ["1", 1_000_000n],
    ["0.4", 400_000n],
    ["0.40", 400_000n],
    ["12.345678", 12_345_678n],
    ["0.000001", 1n],
    ["007.5", 7_500_000n],
    ["340282366920938463463374607431768.211455", MAX_UINT128],
  ])("parses %s", (text, units) => {
    expect(parseUsdc(text)).toBe(units);
  });

  it.each(["", "-1", "+1", "1.", ".5", "1.2345678", "1e6", " 1", "1 ", "1,5", "NaN", "0x10"])(
    "rejects %j",
    (text) => {
      expect(() => parseUsdc(text)).toThrow(MoneyError);
    },
  );
});

describe("formatUsdc", () => {
  it.each([
    [0n, "0.00"],
    [1_000_000n, "1.00"],
    [1_230_000n, "1.23"],
    [1_234_500n, "1.2345"],
    [10n, "0.00001"],
    [-400_000n, "-0.40"],
  ])("formats %s as %s", (units, text) => {
    expect(formatUsdc(units)).toBe(text);
  });

  it("honours minDecimals", () => {
    expect(formatUsdc(1_000_000n, { minDecimals: 0 })).toBe("1");
    expect(formatUsdc(1_500_000n, { minDecimals: 4 })).toBe("1.5000");
  });

  it("rejects an invalid minDecimals", () => {
    expect(() => formatUsdc(1n, { minDecimals: 7 })).toThrow(MoneyError);
    expect(() => formatUsdc(1n, { minDecimals: 1.5 })).toThrow(MoneyError);
  });

  it("round-trips with parseUsdc", () => {
    for (const units of [0n, 1n, 99n, 400_000n, 12_345_678n, 10n ** 20n]) {
      expect(parseUsdc(formatUsdc(units))).toBe(units);
    }
  });
});

describe("native (18 decimals) <-> USDC base units (6 decimals)", () => {
  it("converts one USDC both ways", () => {
    expect(usdcToNative(1_000_000n)).toBe(10n ** 18n);
    expect(nativeToUsdcExact(10n ** 18n)).toBe(1_000_000n);
  });

  it("refuses inexact native amounts in exact mode", () => {
    expect(() => nativeToUsdcExact(10n ** 18n + 1n)).toThrow(MoneyError);
  });

  it("floors dust for display", () => {
    expect(nativeToUsdcFloor(10n ** 18n + 999_999_999_999n)).toBe(1_000_000n);
    expect(nativeToUsdcFloor(999_999_999_999n)).toBe(0n);
    expect(() => nativeToUsdcFloor(-1n)).toThrow(MoneyError);
  });

  it("round-trips every base-unit amount exactly", () => {
    for (const units of [0n, 1n, 123_456n, MAX_UINT128]) {
      expect(nativeToUsdcExact(usdcToNative(units))).toBe(units);
    }
  });
});

describe("contract range", () => {
  it("accepts 0 and uint128 max", () => {
    expect(assertContractAmount(0n)).toBe(0n);
    expect(assertContractAmount(MAX_UINT128)).toBe(MAX_UINT128);
  });

  it("rejects negatives and overflow", () => {
    expect(() => assertContractAmount(-1n)).toThrow(MoneyError);
    expect(() => assertContractAmount(MAX_UINT128 + 1n)).toThrow(MoneyError);
  });
});

describe("JSON form", () => {
  it("round-trips", () => {
    expect(usdcFromJson(usdcToJson(12_345_678n))).toBe(12_345_678n);
  });

  it.each(["", "-1", "1.5", "1e3", " 1"])("rejects %j", (text) => {
    expect(() => usdcFromJson(text)).toThrow(MoneyError);
  });
});

describe("sumUsdc", () => {
  it("adds without floating point error", () => {
    expect(sumUsdc([100_000n, 200_000n])).toBe(300_000n);
    expect(sumUsdc([])).toBe(0n);
  });
});
