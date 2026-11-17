import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  formatBaseUnits,
  formatQty,
  maxOverageUnits,
  mulQtyUp,
  overageCost,
  qty,
  usdc,
  divCeil,
  periodAt,
  parseHours,
  describePeriod,
  HOUR_MS,
} from "../src/index.ts";

describe("qty", () => {
  test.each([
    ["1", 1_000_000_000n],
    ["0.5", 500_000_000n],
    ["1000", 1_000_000_000_000n],
    ["0.000000001", 1n],
    ["-2.25", -2_250_000_000n],
  ])("qty(%s)", (input, expected) => {
    expect(qty(input)).toBe(expected);
    expect(formatQty(expected)).toBe(input);
  });

  test("numbers and bigints", () => {
    expect(qty(10)).toBe(qty("10"));
    expect(qty(0.5)).toBe(qty("0.5"));
    expect(qty(3n)).toBe(qty("3"));
  });

  test("rejects too many decimals and junk", () => {
    expect(() => qty("0.0000000001")).toThrow(RangeError);
    expect(() => qty("1e3")).toThrow(RangeError);
    expect(() => qty("abc")).toThrow(RangeError);
    expect(() => qty(Number.NaN)).toThrow(RangeError);
  });

  test("mulQtyUp rounds up to the smallest unit", () => {
    expect(mulQtyUp(qty(3), qty(10))).toBe(qty(30));
    expect(mulQtyUp(qty("0.000000001"), qty("0.5"))).toBe(1n);
  });

  test("divCeil", () => {
    expect(divCeil(7n, 2n)).toBe(4n);
    expect(divCeil(6n, 2n)).toBe(3n);
    expect(divCeil(0n, 2n)).toBe(0n);
    expect(divCeil(-7n, 2n)).toBe(-3n);
  });
});

describe("money", () => {
  test.each([
    ["20", 20_000_000n],
    ["0.01", 10_000n],
    ["70", 70_000_000n],
    ["0.000001", 1n],
  ])("usdc(%s)", (input, expected) => {
    expect(usdc(input)).toBe(expected);
    expect(formatBaseUnits(expected)).toBe(input);
  });

  test("usdc rejects 7 decimals", () => {
    expect(() => usdc("0.0000001")).toThrow(RangeError);
  });

  // The Pro plan from doc 04: overage 0.01 USDC per credit, capped at 50 USDC.
  const pro = { price: usdc("0.01"), per: qty(1), cap: usdc("50") };

  test.each([
    [qty(0), 0n],
    [qty(1), 10_000n],
    [qty(500), usdc("5")],
    [qty("0.5"), 5_000n],
    [qty("0.0001"), 1n], // a hundredth of a base unit rounds up to one
    [qty(5000), usdc("50")],
  ])("overageCost(%s units)", (units, cost) => {
    expect(overageCost(units, pro)).toBe(cost);
  });

  test("billing in packages: 1 USDC per 1000 tokens", () => {
    const p = { price: usdc("1"), per: qty(1000), cap: usdc("100") };
    expect(overageCost(qty(1000), p)).toBe(usdc("1"));
    expect(overageCost(qty(1), p)).toBe(1_000n);
    expect(overageCost(qty(1500), p)).toBe(usdc("1.5"));
  });

  test("maxOverageUnits is the exact inverse of overageCost under the cap", () => {
    expect(maxOverageUnits(pro)).toBe(qty(5000));
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.bigInt({ min: 1n, max: qty(10_000) }),
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        (price, per, cap) => {
          const p = { price, per, cap };
          const max = maxOverageUnits(p);
          expect(overageCost(max, p) <= cap).toBe(true);
          expect(overageCost(max + 1n, p) > cap).toBe(true);
        },
      ),
    );
  });
});

describe("periods", () => {
  const anchor = new Date("2026-11-01T10:00:00Z");

  test("periodAt counts whole periods from the anchor", () => {
    const p = periodAt(anchor, 720, new Date("2026-12-05T00:00:00Z"));
    expect(p.start.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-12-31T10:00:00.000Z");
  });

  test("the boundary instant belongs to the next period", () => {
    const p = periodAt(anchor, 1, new Date(anchor.getTime() + HOUR_MS));
    expect(p.start.getTime()).toBe(anchor.getTime() + HOUR_MS);
  });

  test("before the anchor is the first period", () => {
    const p = periodAt(anchor, 24, new Date("2026-10-01T00:00:00Z"));
    expect(p.start).toEqual(anchor);
  });

  test("parseHours and describePeriod", () => {
    expect(parseHours("30d")).toBe(720);
    expect(parseHours("12h")).toBe(12);
    expect(parseHours(5)).toBe(5);
    expect(() => parseHours("1 month")).toThrow();
    expect(describePeriod(720)).toBe("every 30 days");
    expect(describePeriod(1)).toBe("every hour");
  });
});
