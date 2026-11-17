/**
 * Milestone M3 flows against a real Postgres and the in-memory FakeChain:
 * plan changes with proration, scheduled downgrades, one-off and automatic
 * top-ups, and the customer portal's cancel and resume.
 *
 * Plans: Pro 2 USDC/h (100 credits, overage 0.01 capped at 5, ceiling 7);
 * Team 5 USDC/h (500 credits, overage capped at 5, ceiling 10);
 * Refill 1 USDC/h (10 credits, automatic top-up of 100 credits for 1 USDC, at
 * most twice a period, ceiling 3).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { defineConfig, feature, plan, toDocument, usdc } from "@usenummo/config";
import { HOUR_MS } from "@usenummo/core";
import { applyConfig, attach, clock, createTopUp, getCustomer, NummoError, preview, schema, track, type Db, type Scope } from "@usenummo/db";
import { FakeChain } from "@usenummo/solana/testing";
import {
  createPortalSession,
  getPortal,
  planIdSeed,
  prepareCheckoutTransaction,
  preparePortalAction,
  registerPublishedPlan,
  type SettlementSettings,
  settleAll,
  submitCheckout,
  submitPortalAction,
  verify,
} from "../src/index.ts";
import { closeTestDb, freshScope, ledgerDrift, testDb } from "../../db/test/helpers.ts";

const { grants, invoiceLines, invoices, outbox, payments, subscriptions } = schema;
const MERCHANT = "merchant_wallet";

const credits = { feature: "credits", reset: "period" as const };
const config = defineConfig({
  payTo: undefined,
  features: [
    feature({ id: "message", type: "metered" }),
    feature({ id: "credits", type: "credit_system", rates: [{ feature: "message", credits: 1 }] }),
  ],
  plans: [
    plan({ id: "free", version: 1, name: "Free", default: true, items: [{ feature: "credits", included: 10, reset: "30d" }] }),
    plan({
      id: "pro",
      version: 1,
      name: "Pro",
      price: { amount: usdc("2"), period: "1h" },
      items: [{ ...credits, included: 100, overage: { price: usdc("0.01"), per: 1, cap: usdc("5") } }],
    }),
    plan({
      id: "team",
      version: 1,
      name: "Team",
      price: { amount: usdc("5"), period: "1h" },
      items: [{ ...credits, included: 500, overage: { price: usdc("0.01"), per: 1, cap: usdc("5") } }],
    }),
    plan({
      id: "refill",
      version: 1,
      name: "Refill",
      price: { amount: usdc("1"), period: "1h" },
      items: [{ ...credits, included: 10, autoTopUp: { below: 5, quantity: 100, price: usdc("1"), maxPerPeriod: 2 } }],
    }),
  ],
  topUps: [{ feature: "credits", price: usdc("1"), per: 100, min: usdc("1"), max: usdc("50") }],
});

const settings: SettlementSettings = {
  threshold: usdc("1"),
  retrySchedule: [60_000, 120_000, 180_000],
  boundaryMarginMs: 30_000,
  closeWindowMs: (p) => p / 10,
  confirmWaitMs: 0,
  pollMs: 0,
  publicUrl: "http://nummo.test",
};

let db: Db;
let chain: FakeChain;
let scope: Scope;
const realNow = clock.now;

beforeEach(async () => {
  db = await testDb();
  chain = new FakeChain({ now: new Date(Math.floor(Date.now() / 1000) * 1000) });
  clock.now = () => chain.now();
  scope = await freshScope(db);
  await applyConfig(db, scope, toDocument(config));
  for (const [id, amount] of [["pro", "7"], ["team", "10"], ["refill", "3"]] as const) {
    const p = chain.createPlan({ owner: MERCHANT, planId: planIdSeed(scope, id, 1), amount: usdc(amount), periodHours: 1 });
    await registerPublishedPlan(db, chain, scope, id, 1, p.address);
  }
});
afterEach(() => {
  clock.now = realNow;
});
afterAll(closeTestDb);

const chains = () => ({ test: chain });
const tick = () => settleAll(db, chains(), settings, chain.now());
const idOf = (url: string) => url.split("/").pop()!;

async function pay(checkoutUrl: string, wallet: string) {
  const id = idOf(checkoutUrl);
  const { transaction } = await prepareCheckoutTransaction(db, chains(), id, wallet, chain.now());
  return submitCheckout(db, chains(), settings, id, chain.walletSign(transaction, wallet));
}

async function subscribe(customerId: string, planId: string, balance: bigint) {
  const a = await attach(db, scope, { customerId, planId }, { publicUrl: settings.publicUrl });
  const wallet = chain.wallet(balance);
  const done = await pay(a.checkoutUrl!, wallet);
  expect(done.status).toBe("completed");
  return { wallet, subscriptionId: a.subscriptionId! };
}

const sub = async (id: string) => (await db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!;
const balance = async (c: string) => (await getCustomer(db, scope, c)).balances.find((b) => b.featureId === "credits")?.balance;
const liveSubs = async (c: string) =>
  (await getCustomer(db, scope, c)).subscriptions.filter((s) => ["active", "past_due", "canceling"].includes(s.status) && !s.replacedBy);
async function eventsOf(type: string) {
  return (await db.select().from(outbox).where(and(eq(outbox.orgId, scope.orgId), eq(outbox.eventType, type)))).map((e) => e.payload as Record<string, unknown>);
}
async function expectNoDrift() {
  const r = await verify(db, chain, scope, chain.now());
  expect(r.differences.filter((d) => d.severity === "drift")).toEqual([]);
  expect(await ledgerDrift(db, scope)).toEqual([]);
}

describe("upgrade", () => {
  test("half way through the period: one signature pays the difference and cancels the old plan", async () => {
    const { wallet, subscriptionId: proId } = await subscribe("u1", "pro", usdc("20"));
    chain.advance(30 * 60_000);

    const p = await preview(db, scope, { customerId: "u1", planId: "team" });
    expect(p).toMatchObject({ change: "upgrade", dueNow: "4", credit: "1", signatureRequired: true });

    const a = await attach(db, scope, { customerId: "u1", planId: "team" }, { publicUrl: settings.publicUrl });
    expect(a).toMatchObject({ status: "pending", proration: { credit: "1", dueNow: "4" } });
    // Asking again returns the same checkout.
    expect((await attach(db, scope, { customerId: "u1", planId: "team" }, { publicUrl: settings.publicUrl })).checkoutUrl).toBe(a.checkoutUrl);

    // Another wallet cannot sign: the change cancels the subscription the current wallet pays for.
    const other = chain.wallet(usdc("20"));
    await expect(prepareCheckoutTransaction(db, chains(), idOf(a.checkoutUrl!), other, chain.now())).rejects.toMatchObject({ code: "wrong_wallet" });

    const done = await pay(a.checkoutUrl!, wallet);
    expect(done).toMatchObject({ status: "completed", kind: "change", change: { from: { id: "pro" }, credit: "1" } });
    expect(chain.transfers.at(-1)!.amount).toBe(usdc("4"));

    const team = await sub(a.subscriptionId!);
    expect(team.status).toBe("active");
    const old = await sub(proId);
    expect(old).toMatchObject({ status: "canceling", replacedBy: team.id });
    const oldOnchain = (await chain.getSubscription(old.subscriptionPda!))!;
    expect(old.cancelAt!.getTime()).toBe(oldOnchain.expiresAt!.getTime());

    // Entitlements now come from Team only.
    expect(await balance("u1")).toBe("500");
    expect((await liveSubs("u1")).map((s) => s.planId)).toEqual(["team"]);

    const [inv] = await db.select().from(invoices).where(and(eq(invoices.subscriptionId, team.id), eq(invoices.kind, "activation")));
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id));
    expect(lines.map((l) => [l.kind, l.amount]).sort()).toEqual([["base", usdc("5")], ["proration", -usdc("1")]]);
    expect(inv!.total).toBe(usdc("4"));
    expect((await eventsOf("subscription.canceled")).at(-1)).toMatchObject({ reason: "replaced", replacedBy: team.id });
    await expectNoDrift();

    // When the old period ends the old subscription ends, and nothing falls back to free.
    chain.advance(31 * 60_000);
    await tick();
    expect(await sub(proId)).toMatchObject({ status: "ended", endedReason: "replaced" });
    expect((await liveSubs("u1")).map((s) => s.planId)).toEqual(["team"]);
    await expectNoDrift();
  });

  test("overage used on the old plan is still collected from it after the change", async () => {
    const { wallet, subscriptionId: proId } = await subscribe("u2", "pro", usdc("30"));
    await track(db, scope, { customerId: "u2", featureId: "message", value: "150" }); // 50 over: 0.50 USDC, below the threshold
    chain.advance(10 * 60_000);
    const a = await attach(db, scope, { customerId: "u2", planId: "team" }, { publicUrl: settings.publicUrl });
    await pay(a.checkoutUrl!, wallet);

    await tick();
    const pulled = chain.transfers.filter((t) => t.amount === usdc("0.5"));
    expect(pulled).toHaveLength(1);
    const oldInvoices = await db.select().from(invoices).where(and(eq(invoices.subscriptionId, proId), eq(invoices.kind, "overage")));
    expect(oldInvoices).toMatchObject([{ status: "paid", total: usdc("0.5") }]);
    // Usage after the change goes to Team.
    await track(db, scope, { customerId: "u2", featureId: "message", value: "10" });
    expect(await balance("u2")).toBe("490");
    await expectNoDrift();
  });

  test("blocked while a payment on the current plan has failed", async () => {
    const { subscriptionId } = await subscribe("u3", "pro", usdc("2"));
    await db.update(subscriptions).set({ status: "past_due", pastDueSince: chain.now() }).where(eq(subscriptions.id, subscriptionId));
    await expect(attach(db, scope, { customerId: "u3", planId: "team" }, { publicUrl: settings.publicUrl })).rejects.toMatchObject({
      code: "plan_change_blocked",
    });
    expect(await preview(db, scope, { customerId: "u3", planId: "team" })).toMatchObject({ change: "blocked" });
  });
});

describe("downgrade", () => {
  test("to a cheaper paid plan: scheduled for the period end, then the customer signs the new plan", async () => {
    const { wallet, subscriptionId: teamId } = await subscribe("d1", "team", usdc("20"));
    const a = await attach(db, scope, { customerId: "d1", planId: "pro" }, { publicUrl: settings.publicUrl });
    expect(a.status).toBe("scheduled");
    expect(new Date(a.effectiveAt!).getTime()).toBe((await sub(teamId)).periodAnchor.getTime() + HOUR_MS);
    expect((await getCustomer(db, scope, "d1")).subscriptions.find((x) => x.id === teamId)!.scheduledChange).toMatchObject({ planId: "pro" });

    // Still Team until the period ends; no renewal is pulled for Team after it.
    expect(await balance("d1")).toBe("500");
    chain.advance(HOUR_MS + 60_000);
    await tick();
    expect(await sub(teamId)).toMatchObject({ status: "ended", endedReason: "downgraded" });
    expect(chain.transfers.filter((t) => t.from === wallet)).toHaveLength(1); // only the activation
    const ended = (await eventsOf("subscription.ended")).at(-1)!;
    expect(ended).toMatchObject({ reason: "downgraded", next: { planId: "pro", status: "pending" } });

    // Free in the meantime; the portal shows the checkout to finish the switch.
    const c = await getCustomer(db, scope, "d1");
    expect((await liveSubs("d1")).map((s) => s.planId)).toEqual(["free"]);
    const pending = c.pendingCheckouts.find((x) => x.planId === "pro")!;
    expect(pending).toMatchObject({ kind: "subscribe", amount: "2" });
    const done = await pay(`${settings.publicUrl}/checkout/${pending.id}`, chain.wallet(usdc("5")));
    expect(done.status).toBe("completed");
    expect((await liveSubs("d1")).map((s) => s.planId)).toEqual(["pro"]);
    await expectNoDrift();
  });

  test("to free: scheduled, and attaching the current plan again cancels it", async () => {
    const { subscriptionId } = await subscribe("d2", "pro", usdc("10"));
    expect((await attach(db, scope, { customerId: "d2", planId: "free" }, { publicUrl: settings.publicUrl })).status).toBe("scheduled");
    const again = await attach(db, scope, { customerId: "d2", planId: "pro" }, { publicUrl: settings.publicUrl });
    expect(again).toMatchObject({ alreadyAttached: true, status: "active" });
    expect((await sub(subscriptionId)).scheduledPlanVersionId).toBeNull();

    await attach(db, scope, { customerId: "d2", planId: "free" }, { publicUrl: settings.publicUrl });
    chain.advance(HOUR_MS + 60_000);
    await tick();
    expect((await liveSubs("d2")).map((s) => s.planId)).toEqual(["free"]);
    expect((await getCustomer(db, scope, "d2")).subscriptions.filter((s) => s.planId === "free" && s.status === "active")).toHaveLength(1);
  });
});

describe("one-off top-ups", () => {
  test("a wallet buys 200 credits for 2 USDC; they arrive with the payment and outlast the period", async () => {
    await subscribe("t1", "pro", usdc("10"));
    const t = await createTopUp(db, scope, { customerId: "t1", featureId: "credits", amount: usdc("2") }, { publicUrl: settings.publicUrl, reference: () => chain.newReference() });
    expect(t).toMatchObject({ quantity: "200", amount: "2" });

    const wallet = chain.wallet(usdc("3"));
    const before = chain.balances.get(MERCHANT)!;
    const done = await pay(t.checkoutUrl, wallet);
    expect(done).toMatchObject({ status: "completed", kind: "topup", topup: { quantity: "200", payTo: MERCHANT } });
    expect(chain.balances.get(MERCHANT)! - before).toBe(usdc("2"));
    expect(await balance("t1")).toBe("300");

    const [inv] = await db.select().from(invoices).where(and(eq(invoices.customerId, "t1"), eq(invoices.kind, "topup"), eq(invoices.orgId, scope.orgId)));
    expect(inv).toMatchObject({ status: "paid", subscriptionId: null, total: usdc("2") });
    expect(await db.select().from(payments).where(eq(payments.invoiceId, inv!.id))).toHaveLength(1);

    // Plan credits are used first; the purchased ones carry over.
    await track(db, scope, { customerId: "t1", featureId: "message", value: "120" });
    expect(await balance("t1")).toBe("180");
    chain.advance(HOUR_MS + 60_000);
    await tick();
    expect(await balance("t1")).toBe("280");
    await expectNoDrift();
  });

  test("limits and unknown features are refused", async () => {
    const opts = { publicUrl: settings.publicUrl, reference: () => chain.newReference() };
    await expect(createTopUp(db, scope, { customerId: "t2", featureId: "credits", amount: usdc("0.5") }, opts)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(createTopUp(db, scope, { customerId: "t2", featureId: "credits", amount: usdc("51") }, opts)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(createTopUp(db, scope, { customerId: "t2", featureId: "message", amount: usdc("5") }, opts)).rejects.toMatchObject({ code: "topup_not_available" });
  });

  test("a wallet without enough USDC is told before it signs", async () => {
    const t = await createTopUp(db, scope, { customerId: "t3", featureId: "credits", amount: usdc("5") }, { publicUrl: settings.publicUrl, reference: () => chain.newReference() });
    await expect(prepareCheckoutTransaction(db, chains(), idOf(t.checkoutUrl), chain.wallet(usdc("1")), chain.now())).rejects.toMatchObject({ code: "wallet_not_ready" });
  });
});

describe("automatic top-ups", () => {
  test("below the threshold a refill is pulled from the subscription, at most twice a period", async () => {
    const { wallet } = await subscribe("a1", "refill", usdc("10"));
    expect(await balance("a1")).toBe("10");

    await track(db, scope, { customerId: "a1", featureId: "message", value: "6" }); // 4 left, below 5
    const open = await db.select().from(invoices).where(and(eq(invoices.customerId, "a1"), eq(invoices.kind, "topup"), eq(invoices.orgId, scope.orgId)));
    expect(open).toMatchObject([{ status: "open", total: usdc("1") }]);
    // Credits arrive only once the money has.
    expect(await balance("a1")).toBe("4");
    // More usage below the threshold does not stack a second refill while one is open.
    await track(db, scope, { customerId: "a1", featureId: "message", value: "1" });

    await tick();
    expect(await balance("a1")).toBe("103");
    expect(chain.transfers.at(-1)).toMatchObject({ from: wallet, amount: usdc("1") });

    await track(db, scope, { customerId: "a1", featureId: "message", value: "100" }); // 3 left: second refill
    await tick();
    expect(await balance("a1")).toBe("103");
    await track(db, scope, { customerId: "a1", featureId: "message", value: "100" }); // 3 left: the period's limit is reached
    await tick();
    expect(await balance("a1")).toBe("3");
    const all = await db.select().from(invoices).where(and(eq(invoices.customerId, "a1"), eq(invoices.kind, "topup"), eq(invoices.orgId, scope.orgId)));
    expect(all.map((i) => i.status)).toEqual(["paid", "paid"]);
    await expectNoDrift();

    // Next period: the plan grant resets, and refills are allowed again.
    chain.advance(HOUR_MS + 60_000);
    await tick();
    await track(db, scope, { customerId: "a1", featureId: "message", value: "10" });
    await tick();
    expect(await db.select().from(grants).where(and(eq(grants.customerId, "a1"), eq(grants.source, "topup"), eq(grants.orgId, scope.orgId)))).toHaveLength(3);
    await expectNoDrift();
  });
});

describe("portal", () => {
  test("shows the plan and receipts, and cancels and resumes with the customer's wallet", async () => {
    const { wallet, subscriptionId } = await subscribe("p1", "pro", usdc("10"));
    const { url } = await createPortalSession(db, scope, { customerId: "p1", returnUrl: "https://app.example/settings" }, settings.publicUrl);
    const id = idOf(url);

    const data = await getPortal(db, chains(), id);
    expect(data.customer.subscriptions.find((x) => x.id === subscriptionId)).toMatchObject({ planId: "pro", status: "active", ceiling: "7", wallet });
    expect(data.customer.invoices[0]!.payments[0]!.signature).toBeTruthy();
    expect(data.plans.map((p) => [p.planId, p.current])).toEqual([["free", false], ["refill", false], ["pro", true], ["team", false]]);
    expect(data.topUps).toEqual([{ featureId: "credits", price: "1", per: "100", min: "1", max: "50" }]);

    await expect(preparePortalAction(db, chains(), id, { action: "cancel", subscriptionId, wallet: chain.wallet(0n) })).rejects.toMatchObject({ code: "wrong_wallet" });
    const c = await preparePortalAction(db, chains(), id, { action: "cancel", subscriptionId, wallet });
    const r = await submitPortalAction(db, chains(), settings, id, chain.walletSign(c.transaction, wallet));
    expect(r.confirmed).toBe(true);
    const s = await sub(subscriptionId);
    expect(s.status).toBe("canceling");
    expect(s.cancelAt!.getTime()).toBe(s.periodAnchor.getTime() + HOUR_MS);
    await expectNoDrift();

    const res = await preparePortalAction(db, chains(), id, { action: "resume", subscriptionId, wallet });
    await submitPortalAction(db, chains(), settings, id, chain.walletSign(res.transaction, wallet));
    expect(await sub(subscriptionId)).toMatchObject({ status: "active", cancelAt: null });
    await expectNoDrift();

    // A tampered transaction is refused.
    const again = await preparePortalAction(db, chains(), id, { action: "cancel", subscriptionId, wallet });
    const other = await chain.buildCancel({ plan: "plan_x", subscriber: wallet });
    await expect(submitPortalAction(db, chains(), settings, id, chain.walletSign(other.transaction, wallet))).rejects.toBeInstanceOf(NummoError);
    expect(again.transaction).toBeTruthy();
  });

  test("an expired or unknown link is refused", async () => {
    await expect(getPortal(db, chains(), "ps_nope")).rejects.toMatchObject({ code: "portal_not_found" });
  });
});
