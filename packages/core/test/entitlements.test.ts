import { describe, expect, test } from "vitest";
import {
  type CustomerSnapshot,
  type EntitlementItem,
  type Grant,
  accrualKey,
  canCover,
  hasBooleanFeature,
  poolsFor,
  qty,
  reconcileGrants,
  usdc,
} from "../src/index.ts";

const anchor = new Date("2026-11-01T00:00:00Z");
const H = 3_600_000;
let n = 0;
const newId = () => `new${++n}`;

const freeCredits: EntitlementItem = {
  subscriptionId: "sub_free",
  featureId: "credits",
  included: qty(100),
  reset: { kind: "every", hours: 720 },
  periodAnchor: anchor,
  billingPeriodHours: 720,
  overage: null,
};

describe("reconcileGrants (rule 9)", () => {
  test("issues the current period's grant once", () => {
    const now = new Date(anchor.getTime() + 5 * H);
    const first = reconcileGrants([freeCredits], [], now, newId);
    expect(first.create).toHaveLength(1);
    const g = first.create[0]!;
    expect(g.amount).toBe(qty(100));
    expect(g.periodStart).toEqual(anchor);
    expect(g.expiresAt).toEqual(new Date(anchor.getTime() + 720 * H));
    expect(reconcileGrants([freeCredits], [g], now, newId).create).toHaveLength(0);
  });

  test("after the period ends: expire the leftover and issue a fresh grant, skipping missed periods", () => {
    const old: Grant = {
      id: "old",
      featureId: "credits",
      source: "plan",
      amount: qty(100),
      remaining: qty(40),
      resetHours: 720,
      expiresAt: new Date(anchor.getTime() + 720 * H),
      createdAt: anchor,
      subscriptionId: "sub_free",
      periodStart: anchor,
    };
    const now = new Date(anchor.getTime() + 3 * 720 * H + 7 * H); // fourth period
    const r = reconcileGrants([freeCredits], [old], now, newId);
    expect(r.expire.map((g) => g.id)).toEqual(["old"]);
    expect(r.create).toHaveLength(1);
    expect(r.create[0]!.periodStart).toEqual(new Date(anchor.getTime() + 3 * 720 * H));
  });

  test("never-resetting items are granted once", () => {
    const item: EntitlementItem = { ...freeCredits, reset: { kind: "never" } };
    const r = reconcileGrants([item], [], anchor, newId);
    expect(r.create[0]!.expiresAt).toBeNull();
    expect(r.create[0]!.resetHours).toBeNull();
    expect(reconcileGrants([item], r.create, anchor, newId).create).toHaveLength(0);
  });

  test("boolean items get no grant", () => {
    const sso: EntitlementItem = { ...freeCredits, featureId: "sso", included: null, reset: { kind: "never" } };
    expect(reconcileGrants([sso], [], anchor, newId).create).toHaveLength(0);
  });
});

describe("poolsFor", () => {
  const catalog = {
    features: new Map([
      ["credits", { id: "credits", type: "credit_system" as const }],
      ["premium_message", { id: "premium_message", type: "metered" as const }],
      ["sso", { id: "sso", type: "boolean" as const }],
    ]),
    creditRates: new Map([["premium_message", { creditFeatureId: "credits", rate: qty(10) }]]),
  };
  const now = new Date(anchor.getTime() + H);

  test("free plan: premium messages draw from credits and stop at zero", () => {
    const grants = reconcileGrants([freeCredits], [], now, newId).create;
    const snap: CustomerSnapshot = { grants, items: [freeCredits], overageUsed: new Map(), overageBlocked: new Set() };
    const pools = poolsFor(catalog, snap, "premium_message", now);
    expect(pools.map((p) => p.featureId)).toEqual(["credits"]);
    expect(canCover(pools, qty(10), now)).toBe(true);
    expect(canCover(pools, qty(11), now)).toBe(false);
  });

  test("pro plan: overage is accrued against the subscription's billing period", () => {
    const pro: EntitlementItem = {
      ...freeCredits,
      subscriptionId: "sub_pro",
      included: qty(1000),
      overage: { price: usdc("0.01"), per: qty(1), cap: usdc("50") },
    };
    const snap: CustomerSnapshot = {
      grants: [],
      items: [pro],
      overageUsed: new Map([[accrualKey("sub_pro", "credits"), qty(100)]]),
      overageBlocked: new Set(),
    };
    const [credit] = poolsFor(catalog, snap, "premium_message", now);
    expect(credit!.overage?.usedUnits).toBe(qty(100));
    expect(credit!.overage?.periodStart).toEqual(anchor);
    expect(credit!.overage?.subscriptionId).toBe("sub_pro");
  });

  test("boolean features", () => {
    const sso: EntitlementItem = { ...freeCredits, featureId: "sso", included: null };
    const snap: CustomerSnapshot = { grants: [], items: [sso], overageUsed: new Map(), overageBlocked: new Set() };
    expect(hasBooleanFeature(snap, "sso")).toBe(true);
    expect(hasBooleanFeature({ ...snap, items: [] }, "sso")).toBe(false);
  });
});
