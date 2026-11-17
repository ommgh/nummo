/**
 * Exact decimal quantities for features and credits.
 *
 * Feature quantities may be fractional (a credit rate of 0.5 is allowed), but
 * floating point is never used: a quantity is a bigint scaled by 10^9, matching
 * the database column type `numeric(38, 9)`.
 */

export type Qty = bigint;

export const QTY_DECIMALS = 9;
export const QTY_SCALE = 10n ** BigInt(QTY_DECIMALS);
export const ZERO: Qty = 0n;

const QTY_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parse a decimal string or a safe number into a Qty. Throws on more than 9 decimals. */
export function qty(value: string | number | bigint): Qty {
  if (typeof value === "bigint") return value * QTY_SCALE;
  const s = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const m = QTY_PATTERN.exec(s);
  if (!m) throw new RangeError(`invalid quantity: ${JSON.stringify(value)}`);
  const [, sign, whole, frac = ""] = m;
  if (frac.length > QTY_DECIMALS) {
    throw new RangeError(`quantity has more than ${QTY_DECIMALS} decimals: ${s}`);
  }
  const scaled = BigInt(whole!) * QTY_SCALE + BigInt(frac.padEnd(QTY_DECIMALS, "0"));
  return sign ? -scaled : scaled;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`invalid quantity: ${n}`);
  // toFixed avoids exponent notation; then trim trailing zeros.
  const s = n.toFixed(QTY_DECIMALS);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Format a Qty as a plain decimal string with no trailing zeros ("1.5", "100"). */
export function formatQty(q: Qty): string {
  const neg = q < 0n;
  const abs = neg ? -q : q;
  const whole = abs / QTY_SCALE;
  const frac = (abs % QTY_SCALE).toString().padStart(QTY_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** a * b for two Qty values, rounded up (away from zero for positives). */
export function mulQtyUp(a: Qty, b: Qty): Qty {
  return divCeil(a * b, QTY_SCALE);
}

/** Ceiling division for non-negative numerator and positive denominator. */
export function divCeil(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("divisor must be positive");
  if (n <= 0n) return -(-n / d);
  return (n + d - 1n) / d;
}

export function minQty(a: Qty, b: Qty): Qty {
  return a < b ? a : b;
}

export function maxQty(a: Qty, b: Qty): Qty {
  return a > b ? a : b;
}

export function sumQty(values: Iterable<Qty>): Qty {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}
