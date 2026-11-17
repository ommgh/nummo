/**
 * Plan changes and top-ups (doc 03, "Plan changes" and "One-off purchases").
 * Pure arithmetic in base units and exact quantities; no I/O.
 */

import { type BaseUnits } from "./money.ts";
import { type Qty, QTY_SCALE } from "./qty.ts";

export type PlanPrice = { base: BaseUnits; periodHours: number };

export type ProrationInput = {
  from: PlanPrice;
  to: PlanPrice;
  /** The current period of the subscription being replaced. */
  periodStart: Date;
  periodEnd: Date;
  /** Whether the current period's base fee was collected. No credit for a period that was not paid. */
  periodPaid: boolean;
  now: Date;
};

export type Proration = {
  /** "upgrade": takes effect now, with a credit for the unused part of the paid period. "downgrade": at the period end. */
  direction: "upgrade" | "downgrade";
  /** Unused part of the old base fee, in base units. Rounded up, in the customer's favour. */
  credit: BaseUnits;
  /** What the customer pays now for an upgrade: the new base fee less the credit, never below zero. */
  dueNow: BaseUnits;
  /** When the change takes effect. */
  effectiveAt: Date;
};

/**
 * How a change between two paid plans is billed.
 *
 * The new on-chain subscription starts its own period the moment it is signed,
 * so an immediate change starts a fresh period on the new plan: the customer
 * pays the new base fee less the unused part of the old one.
 *
 * A change is an upgrade, and immediate, when the new plan costs at least as
 * much per hour as the old one and the credit fits inside the new base fee (so
 * no credit is ever lost). Anything else is a downgrade, effective when the
 * current period ends, with nothing due now.
 */
export function prorate(input: ProrationInput): Proration {
  const { from, to, periodStart, periodEnd, now } = input;
  const len = BigInt(periodEnd.getTime() - periodStart.getTime());
  const left = BigInt(Math.min(Math.max(periodEnd.getTime() - now.getTime(), 0), periodEnd.getTime() - periodStart.getTime()));
  // ceil(base * left / len)
  const credit = input.periodPaid && len > 0n ? (from.base * left + len - 1n) / len : 0n;
  // Price per hour, compared by cross-multiplying: to.base / to.hours >= from.base / from.hours.
  const notCheaper = to.base * BigInt(from.periodHours) >= from.base * BigInt(to.periodHours);
  if (notCheaper && credit <= to.base) {
    return { direction: "upgrade", credit, dueNow: to.base - credit, effectiveAt: now };
  }
  return { direction: "downgrade", credit: 0n, dueNow: 0n, effectiveAt: periodEnd };
}

/** A top-up price: `price` base units buys `per` units of the feature. */
export type TopUpPrice = { price: BaseUnits; per: Qty };

/** Units a payment of `amount` buys, rounded down to the 10^-9 unit. */
export function topUpQuantity(amount: BaseUnits, p: TopUpPrice): Qty {
  if (amount <= 0n || p.price <= 0n) return 0n;
  return (amount * p.per) / p.price;
}

/** Whole units, for display: 1000.000000000 -> 1000n. */
export function wholeUnits(q: Qty): bigint {
  return q / QTY_SCALE;
}
