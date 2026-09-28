/**
 * Money for Bursar.
 *
 * Every amount is an integer count of USDC base units ("micro-USDC", 6 decimals) held in a
 * bigint. Floats never touch money. On Arc, USDC is also the native gas token with 18 decimals;
 * the native balance and the ERC-20 balance are the same money, so conversion between the two
 * lives here and nowhere else.
 */

export const USDC_DECIMALS = 6;
export const NATIVE_DECIMALS = 18;

/** Base units in one whole USDC. */
export const UNITS_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/** Native (18-decimal) units in one USDC base unit. */
const NATIVE_PER_UNIT = 10n ** BigInt(NATIVE_DECIMALS - USDC_DECIMALS);

/** Largest amount the JobVault contract can store (its amounts are uint128). */
export const MAX_UINT128 = 2n ** 128n - 1n;

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

const decimalText = /^(\d+)(?:\.(\d{1,6}))?$/;
const integerText = /^\d+$/;

/**
 * Parses a human decimal amount such as "1", "0.40" or "12.345678" into base units.
 * Rejects negatives, signs, exponents, whitespace and more than 6 decimal places.
 */
export function parseUsdc(text: string): bigint {
  const match = decimalText.exec(text);
  if (match === null) {
    throw new MoneyError(`Not a valid USDC amount: "${text}"`);
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  return BigInt(whole) * UNITS_PER_USDC + BigInt(fraction);
}

export interface FormatOptions {
  /** Decimal places always shown. Defaults to 2. Extra non-zero places up to 6 are kept. */
  readonly minDecimals?: number;
}

/** Formats base units as a decimal string: 1_230_000n -> "1.23", 10n -> "0.00001". */
export function formatUsdc(units: bigint, options: FormatOptions = {}): string {
  const minDecimals = options.minDecimals ?? 2;
  if (!Number.isInteger(minDecimals) || minDecimals < 0 || minDecimals > USDC_DECIMALS) {
    throw new MoneyError(`minDecimals must be an integer from 0 to ${USDC_DECIMALS}`);
  }
  const sign = units < 0n ? "-" : "";
  const magnitude = units < 0n ? -units : units;
  const whole = magnitude / UNITS_PER_USDC;
  let fraction = (magnitude % UNITS_PER_USDC).toString().padStart(USDC_DECIMALS, "0");
  while (fraction.length > minDecimals && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/** Base units -> Arc native units (18 decimals). Always exact. */
export function usdcToNative(units: bigint): bigint {
  return units * NATIVE_PER_UNIT;
}

/**
 * Arc native units -> base units, only when the value is a whole number of base units.
 * Use this for amounts that must round-trip, such as transfer values.
 */
export function nativeToUsdcExact(native: bigint): bigint {
  if (native % NATIVE_PER_UNIT !== 0n) {
    throw new MoneyError(`Native amount ${native} is not a whole number of USDC base units`);
  }
  return native / NATIVE_PER_UNIT;
}

/**
 * Arc native units -> base units, rounding down. Use this only for displaying balances,
 * where gas can leave sub-unit dust.
 */
export function nativeToUsdcFloor(native: bigint): bigint {
  if (native < 0n) {
    throw new MoneyError("Native balance cannot be negative");
  }
  return native / NATIVE_PER_UNIT;
}

/** Throws unless the amount can be stored by the contract: 0 <= units <= uint128 max. */
export function assertContractAmount(units: bigint): bigint {
  if (units < 0n || units > MAX_UINT128) {
    throw new MoneyError(`Amount ${units} is outside the contract's uint128 range`);
  }
  return units;
}

/** Base units -> JSON-safe integer string (bigint has no JSON form). */
export function usdcToJson(units: bigint): string {
  return units.toString();
}

/** JSON integer string -> base units. Rejects anything but a non-negative integer. */
export function usdcFromJson(text: string): bigint {
  if (!integerText.test(text)) {
    throw new MoneyError(`Not a base-unit integer: "${text}"`);
  }
  return BigInt(text);
}

export function sumUsdc(amounts: Iterable<bigint>): bigint {
  let total = 0n;
  for (const amount of amounts) {
    total += amount;
  }
  return total;
}
