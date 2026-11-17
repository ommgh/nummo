/**
 * Money is always an integer number of token base units (bigint).
 * USDC has 6 decimals, so 1 USDC = 1_000_000n.
 */

import { type Qty, divCeil, QTY_SCALE } from "./qty.ts";

export type BaseUnits = bigint;

export const USDC_DECIMALS = 6;

/** Convert a decimal token amount ("20", "0.01") to base units. Throws if too precise. */
export function toBaseUnits(amount: string | number, decimals: number = USDC_DECIMALS): BaseUnits {
  const s = typeof amount === "number" ? String(amount) : amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`invalid token amount: ${JSON.stringify(amount)}`);
  const [, whole, frac = ""] = m;
  if (frac.length > decimals) {
    throw new RangeError(`amount ${s} has more than ${decimals} decimals`);
  }
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0"));
}

/** usdc("20") === 20_000_000n */
export function usdc(amount: string | number): BaseUnits {
  return toBaseUnits(amount, USDC_DECIMALS);
}

export function formatBaseUnits(amount: BaseUnits, decimals: number = USDC_DECIMALS): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / scale}${frac ? `.${frac}` : ""}`;
}

/** Overage pricing for one plan item: `price` base units per `per` units of the feature. */
export type OveragePrice = {
  price: BaseUnits;
  per: Qty;
  /** Most that overage may cost in one period, in base units. */
  cap: BaseUnits;
};

/**
 * Cost of `units` of overage. Rounds up to the next base unit, so the customer
 * is never charged a fraction and the merchant never loses one (doc 05, money maths).
 */
export function overageCost(units: Qty, p: OveragePrice): BaseUnits {
  if (units <= 0n) return 0n;
  return divCeil(units * p.price, p.per);
}

/**
 * The largest number of overage units whose cost stays within the cap.
 * Inverse of `overageCost`, exact to the 10^-9 unit.
 */
export function maxOverageUnits(p: OveragePrice): Qty {
  if (p.price === 0n) return BigInt(Number.MAX_SAFE_INTEGER) * QTY_SCALE;
  // Largest u with ceil(u * price / per) <= cap  <=>  u * price <= cap * per
  return (p.cap * p.per) / p.price;
}
