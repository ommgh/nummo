import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { HOUR_MS, prorate, qty, topUpQuantity, usdc } from "../src/index.ts";

const start = new Date("2026-11-01T00:00:00Z");
const end = new Date(start.getTime() + 720 * HOUR_MS);
const at = (h: number) => new Date(start.getTime() + h * HOUR_MS);
const pro = { base: usdc("20"), periodHours: 720 };
const team = { base: usdc("50"), periodHours: 720 };
const starter = { base: usdc("10"), periodHours: 720 };

describe("prorate", () => {
  test.each([
    // [hours into the period, credit, due now]
    [0, "20", "30"],
    [360, "10", "40"],
    [540, "5", "45"],
    [720, "0", "50"],
  ])("upgrade %ih into the period", (h, credit, due) => {
    const r = prorate({ from: pro, to: team, periodStart: start, periodEnd: end, periodPaid: true, now: at(h) });
    expect(r).toMatchObject({ direction: "upgrade", credit: usdc(credit), dueNow: usdc(due) });
    expect(r.effectiveAt).toEqual(at(h));
  });

  test("the credit rounds up, in the customer's favour", () => {
    // 20 USDC * (720h - 1ms) / 720h is not a whole number of base units.
    const r = prorate({ from: pro, to: team, periodStart: start, periodEnd: end, periodPaid: true, now: new Date(start.getTime() + 1) });
    expect(r.credit).toBe(usdc("20"));
  });

  test("no credit for a period that was not paid", () => {
    const r = prorate({ from: pro, to: team, periodStart: start, periodEnd: end, periodPaid: false, now: at(360) });
    expect(r).toMatchObject({ direction: "upgrade", credit: 0n, dueNow: usdc("50") });
  });

  test("a cheaper plan is a downgrade at the period end", () => {
    const r = prorate({ from: pro, to: starter, periodStart: start, periodEnd: end, periodPaid: true, now: at(10) });
    expect(r).toEqual({ direction: "downgrade", credit: 0n, dueNow: 0n, effectiveAt: end });
  });

  test("a new version at the same price is an upgrade: a fresh period, the unused part credited", () => {
    const r = prorate({ from: pro, to: pro, periodStart: start, periodEnd: end, periodPaid: true, now: at(360) });
    expect(r).toMatchObject({ direction: "upgrade", credit: usdc("10"), dueNow: usdc("10") });
  });

  test("a dearer but shorter plan whose base cannot absorb the credit waits for the period end", () => {
    // 30 days at 20 -> 1 day at 2 is dearer per hour, but 19 USDC of credit would be lost.
    const r = prorate({ from: pro, to: { base: usdc("2"), periodHours: 24 }, periodStart: start, periodEnd: end, periodPaid: true, now: at(24) });
    expect(r.direction).toBe("downgrade");
  });

  test("properties: credit never exceeds the old base, nothing is due on a downgrade, no credit is lost", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: usdc("1000") }),
        fc.bigInt({ min: 0n, max: usdc("1000") }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 0, max: 2000 * 3600 }),
        fc.boolean(),
        (fromBase, toBase, fromH, toH, sec, paid) => {
          const pEnd = new Date(start.getTime() + fromH * HOUR_MS);
          const now = new Date(Math.min(start.getTime() + sec * 1000, pEnd.getTime()));
          const r = prorate({ from: { base: fromBase, periodHours: fromH }, to: { base: toBase, periodHours: toH }, periodStart: start, periodEnd: pEnd, periodPaid: paid, now });
          expect(r.credit).toBeGreaterThanOrEqual(0n);
          expect(r.credit).toBeLessThanOrEqual(fromBase);
          if (r.direction === "downgrade") {
            expect(r.dueNow).toBe(0n);
            expect(r.effectiveAt).toEqual(pEnd);
          } else {
            expect(r.dueNow + r.credit).toBe(toBase);
          }
        },
      ),
    );
  });
});

describe("topUpQuantity", () => {
  test("10 USDC at 1 USDC per 100 credits buys 1000", () => {
    expect(topUpQuantity(usdc("10"), { price: usdc("1"), per: qty(100) })).toBe(qty(1000));
  });
  test("rounds down to the 10^-9 unit", () => {
    expect(topUpQuantity(1n, { price: 3n, per: qty(1) })).toBe(333_333_333n);
  });
});
