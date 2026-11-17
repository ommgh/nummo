/**
 * Settlement against a real Postgres and the in-memory FakeChain, which follows
 * the Subscriptions program's rules (packages/solana/src/fake-chain.ts).
 *
 * Plan under test: Pro, 2 USDC per hour, 100 credits per period, overage at
 * 0.01 USDC per credit capped at 5 USDC, so the on-chain ceiling is 7 USDC.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { defineConfig, feature, plan, toDocument, usdc } from "@usenummo/config";
import { HOUR_MS } from "@usenummo/core";
import { applyConfig, attach, check, clock, getCustomer, NummoError, schema, track, type Db, type Scope } from "@usenummo/db";
import { FakeChain } from "@usenummo/solana/testing";
import {
  dispatchWebhooks,
  getCheckout,
  planIdSeed,
  prepareCheckoutTransaction,
  reconcileAll,
  registerPublishedPlan,
  resolveSubmittedCheckouts,
  type SettlementSettings,
  setWebhookEndpoint,
  settleAll,
  signPayload,
  submitCheckout,
  verify,
} from "../src/index.ts";
import { closeTestDb, freshScope, ledgerDrift, testDb } from "../../db/test/helpers.ts";

const { invoices, outbox, settlementAttempts, subscriptions } = schema;

const config = defineConfig({
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
      items: [{ feature: "credits", included: 100, reset: "period", overage: { price: usdc("0.01"), per: 1, cap: usdc("5") } }],
    }),
  ],
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

const MERCHANT = "merchant_wallet";
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
  const p = chain.createPlan({ owner: MERCHANT, planId: planIdSeed(scope, "pro", 1), amount: usdc("7"), periodHours: 1 });
  await registerPublishedPlan(db, chain, scope, "pro", 1, p.address);
});
afterEach(() => {
  clock.now = realNow;
});
afterAll(closeTestDb);

const chains = () => ({ test: chain });
const tick = () => settleAll(db, chains(), settings, chain.now());

async function subscribe(customerId: string, balance: bigint) {
  const a = await attach(db, scope, { customerId, planId: "pro" }, { publicUrl: settings.publicUrl });
  expect(a.status).toBe("pending");
  const sessionId = a.checkoutUrl!.split("/").pop()!;
  const wallet = chain.wallet(balance);
  const { transaction } = await prepareCheckoutTransaction(db, chains(), sessionId, wallet, chain.now());
  const done = await submitCheckout(db, chains(), settings, sessionId, chain.walletSign(transaction, wallet));
  return { sessionId, wallet, done, subscriptionId: a.subscriptionId! };
}

async function sub(id: string) {
  return (await db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!;
}
async function events() {
  return (await db.select().from(outbox).where(eq(outbox.orgId, scope.orgId))).map((e) => e.eventType);
}
async function invoicesOf(subscriptionId: string) {
  return db.select().from(invoices).where(eq(invoices.subscriptionId, subscriptionId)).orderBy(invoices.createdAt);
}
async function expectNoDrift() {
  const r = await verify(db, chain, scope, chain.now());
  expect(r.differences.filter((d) => d.severity === "drift")).toEqual([]);
  expect(await ledgerDrift(db, scope)).toEqual([]);
}
const credits = async (c: string) => (await getCustomer(db, scope, c)).balances.find((b) => b.featureId === "credits")?.balance;

describe("checkout", () => {
  test("a wallet subscribes with one signature; the free plan is replaced", async () => {
    await check(db, scope, { customerId: "u1", featureId: "message" }); // creates u1 on the free plan
    const { done, wallet, subscriptionId } = await subscribe("u1", usdc("10"));
    expect(done.status).toBe("completed");
    expect(done.onchain).toMatchObject({ ceiling: "7", periodHours: 1, period: "every hour" });

    const s = await sub(subscriptionId);
    expect(s).toMatchObject({ status: "active", wallet });
    const onchain = (await chain.getSubscription(s.subscriptionPda!))!;
    expect(s.periodAnchor.getTime()).toBe(onchain.currentPeriodStart.getTime());
    expect(chain.balances.get(MERCHANT)).toBe(usdc("2"));
    expect(chain.authorities.has(wallet)).toBe(true);

    const c = await getCustomer(db, scope, "u1");
    expect(c.subscriptions.filter((x) => x.status !== "ended").map((x) => x.planId)).toEqual(["pro"]);
    expect(await credits("u1")).toBe("100");
    expect(c.invoices).toMatchObject([{ kind: "activation", status: "paid", total: "2", payments: [{ amount: "2" }] }]);
    expect(await events()).toEqual(expect.arrayContaining(["subscription.activated", "payment.succeeded", "invoice.finalized", "subscription.ended"]));
    await expectNoDrift();
  });

  test("a transaction changed by the wallet is refused, and nothing is sent", async () => {
    const a = await attach(db, scope, { customerId: "u2", planId: "pro" }, { publicUrl: settings.publicUrl });
    const id = a.checkoutUrl!.split("/").pop()!;
    const wallet = chain.wallet(usdc("10"));
    const { transaction } = await prepareCheckoutTransaction(db, chains(), id, wallet, chain.now());
    const w = JSON.parse(Buffer.from(transaction, "base64").toString());
    const tampered = Buffer.from(JSON.stringify({ ...w, message: Buffer.from("{}").toString("base64"), signers: [wallet] })).toString("base64");
    await expect(submitCheckout(db, chains(), settings, id, tampered)).rejects.toMatchObject({ code: "activation_rejected" });
    await expect(submitCheckout(db, chains(), settings, id, transaction)).rejects.toMatchObject({ code: "activation_rejected" }); // unsigned
    expect(chain.transfers).toHaveLength(0);
    expect((await getCheckout(db, chains(), id, chain.now())).status).toBe("open");
  });

  test("a wallet without enough USDC is told before it signs", async () => {
    const a = await attach(db, scope, { customerId: "u3", planId: "pro" }, { publicUrl: settings.publicUrl });
    const id = a.checkoutUrl!.split("/").pop()!;
    await expect(prepareCheckoutTransaction(db, chains(), id, chain.wallet(usdc("1")), chain.now())).rejects.toMatchObject({ code: "wallet_not_ready" });
  });

  test("an activation still in flight is finished by the worker", async () => {
    const a = await attach(db, scope, { customerId: "u4", planId: "pro" }, { publicUrl: settings.publicUrl });
    const id = a.checkoutUrl!.split("/").pop()!;
    const wallet = chain.wallet(usdc("10"));
    const { transaction } = await prepareCheckoutTransaction(db, chains(), id, wallet, chain.now());
    chain.sendModes.push("pending");
    const r = await submitCheckout(db, chains(), settings, id, chain.walletSign(transaction, wallet));
    expect(r.status).toBe("submitted");
    chain.landPending();
    await resolveSubmittedCheckouts(db, chains(), chain.now());
    expect((await getCheckout(db, chains(), id, chain.now())).status).toBe("completed");
    expect((await sub(a.subscriptionId!)).status).toBe("active");
  });

  test("an unpublished paid plan cannot be attached", async () => {
    const s2 = await freshScope(db);
    await applyConfig(db, s2, toDocument(config));
    await expect(attach(db, s2, { customerId: "x", planId: "pro" })).rejects.toBeInstanceOf(NummoError);
  });
});

describe("collecting", () => {
  test("overage is collected once it reaches the threshold", async () => {
    const { subscriptionId } = await subscribe("o1", usdc("20"));
    await track(db, scope, { customerId: "o1", featureId: "message", value: "150" }); // 50 over: 0.5 USDC
    await tick();
    expect((await invoicesOf(subscriptionId)).length).toBe(1); // below the 1 USDC threshold
    await track(db, scope, { customerId: "o1", featureId: "message", value: "60" }); // 110 over: 1.1 USDC
    await tick();
    const inv = await invoicesOf(subscriptionId);
    expect(inv.map((i) => [i.kind, i.status, i.total])).toEqual([
      ["activation", "paid", usdc("2")],
      ["overage", "paid", usdc("1.1")],
    ]);
    expect(chain.balances.get(MERCHANT)).toBe(usdc("3.1"));
    const lines = (await getCustomer(db, scope, "o1")).invoices.find((i) => i.kind === "overage")!.lines;
    expect(lines).toEqual([{ kind: "overage", featureId: "credits", quantity: "110", amount: "1.1" }]);
    await expectNoDrift();
  });

  test("leftover overage is collected in the close window before the period ends", async () => {
    const { subscriptionId } = await subscribe("o2", usdc("20"));
    await track(db, scope, { customerId: "o2", featureId: "message", value: "130" }); // 0.3 USDC
    await tick();
    chain.advance(HOUR_MS - 5 * 60_000); // 5 minutes left; the window is 6
    await tick();
    expect((await invoicesOf(subscriptionId)).at(-1)).toMatchObject({ kind: "overage", status: "paid", total: usdc("0.3") });
    await expectNoDrift();
  });

  test("renewal at the period boundary pulls the base fee and resets credits", async () => {
    const { subscriptionId } = await subscribe("r1", usdc("20"));
    await track(db, scope, { customerId: "r1", featureId: "message", value: "40" });
    expect(await credits("r1")).toBe("60");
    chain.advance(HOUR_MS + 10_000);
    await tick();
    expect((await invoicesOf(subscriptionId)).length).toBe(1); // inside the boundary margin
    chain.advance(30_000);
    await tick();
    const inv = await invoicesOf(subscriptionId);
    expect(inv.at(-1)).toMatchObject({ kind: "renewal", status: "paid", total: usdc("2") });
    expect(await credits("r1")).toBe("100");
    const s = await sub(subscriptionId);
    const onchain = (await chain.getSubscription(s.subscriptionPda!))!;
    expect(onchain.currentPeriodStart.getTime()).toBe(s.periodAnchor.getTime() + HOUR_MS);
    expect(onchain.amountPulledInPeriod).toBe(usdc("2"));
    expect(await events()).toContain("subscription.renewed");
    await expectNoDrift();
  });

  test("a pull is cut to what the ceiling has left, and overage stops for the period", async () => {
    const { subscriptionId } = await subscribe("c1", usdc("50"));
    // Period 1: 0.5 USDC of overage that the worker never collects in time.
    await track(db, scope, { customerId: "c1", featureId: "message", value: "150" });
    chain.advance(HOUR_MS + 31_000);
    await tick(); // renewal: 2 base + 0.5 carried over = 2.5 against the new period's 7
    expect((await invoicesOf(subscriptionId)).at(-1)).toMatchObject({ kind: "renewal", total: usdc("2.5"), status: "paid" });
    // Period 2: the full 5 USDC overage cap. Only 4.5 is left under the ceiling.
    await track(db, scope, { customerId: "c1", featureId: "message", value: "600" });
    await tick();
    const last = (await invoicesOf(subscriptionId)).at(-1)!;
    expect(last).toMatchObject({ kind: "overage", status: "paid", total: usdc("4.5"), amountPaid: usdc("4.5") });
    const lines = (await getCustomer(db, scope, "c1")).invoices.find((i) => i.id === last.id)!.lines;
    expect(lines).toEqual(
      expect.arrayContaining([
        { kind: "overage", featureId: "credits", quantity: "500", amount: "5" },
        { kind: "writeoff", featureId: null, quantity: null, amount: "-0.5" },
      ]),
    );
    expect((await sub(subscriptionId)).overageBlockedUntil).not.toBeNull();
    const c = await check(db, scope, { customerId: "c1", featureId: "message" });
    expect(c.overage?.allowed).toBe(false);
    expect((await chain.getSubscription((await sub(subscriptionId)).subscriptionPda!))!.amountPulledInPeriod).toBe(usdc("7"));
    await expectNoDrift();
  });
});

describe("failed payments", () => {
  test("past due, retries on schedule, recovers when funded", async () => {
    const { subscriptionId, wallet } = await subscribe("f1", usdc("2"));
    await track(db, scope, { customerId: "f1", featureId: "message", value: "250" }); // 1.5 USDC
    await tick();
    let s = await sub(subscriptionId);
    expect(s.status).toBe("past_due");
    expect(s.nextRetryAt!.getTime()).toBe(s.pastDueSince!.getTime() + 60_000);
    expect(await events()).toEqual(expect.arrayContaining(["payment.failed", "subscription.past_due"]));
    // Overage is blocked while past due (rule 6); entitlements stay.
    expect((await check(db, scope, { customerId: "f1", featureId: "message" })).allowed).toBe(false);

    await tick(); // before the retry time: nothing happens
    expect(await db.select().from(settlementAttempts).where(eq(settlementAttempts.subscriptionId, subscriptionId))).toHaveLength(2);

    chain.advance(60_000);
    await tick(); // retry 1 fails
    s = await sub(subscriptionId);
    expect([s.status, s.retryCount]).toEqual(["past_due", 1]);

    chain.balances.set(wallet, usdc("5"));
    chain.advance(60_000);
    await tick(); // retry 2 succeeds
    s = await sub(subscriptionId);
    expect([s.status, s.pastDueSince, s.nextRetryAt]).toEqual(["active", null, null]);
    expect((await invoicesOf(subscriptionId)).at(-1)).toMatchObject({ kind: "overage", status: "paid" });
    await expectNoDrift();
  });

  test("after the last retry the subscription ends and the customer falls back to free", async () => {
    const { subscriptionId } = await subscribe("f2", usdc("2"));
    await track(db, scope, { customerId: "f2", featureId: "message", value: "250" });
    await tick();
    for (let i = 0; i < 3; i++) {
      chain.advance(60_000);
      await tick();
    }
    const s = await sub(subscriptionId);
    expect([s.status, s.endedReason]).toEqual(["ended", "payment_failed"]);
    expect((await invoicesOf(subscriptionId)).at(-1)!.status).toBe("uncollectible");
    const c = await getCustomer(db, scope, "f2");
    expect(c.subscriptions.filter((x) => x.status === "active").map((x) => x.planId)).toEqual(["free"]);
    expect(await credits("f2")).toBe("10");
    expect(await events()).toContain("subscription.ended");
    await expectNoDrift();
  });
});

describe("reconciliation", () => {
  test("a cancellation signed on-chain is picked up, and the subscription ends at the period end", async () => {
    const { subscriptionId } = await subscribe("k1", usdc("20"));
    const s0 = await sub(subscriptionId);
    chain.advance(10 * 60_000);
    chain.cancel(s0.subscriptionPda!);
    expect((await verify(db, chain, scope, chain.now())).differences.map((d) => d.kind)).toContain("cancellation");
    await reconcileAll(db, chains());
    let s = await sub(subscriptionId);
    expect(s.status).toBe("canceling");
    expect(s.cancelAt!.getTime()).toBe(s0.periodAnchor.getTime() + HOUR_MS);
    expect(await events()).toContain("subscription.canceled");
    await expectNoDrift();

    const merchantBefore = chain.balances.get(MERCHANT);
    chain.advance(HOUR_MS);
    await tick();
    s = await sub(subscriptionId);
    expect([s.status, s.endedReason]).toEqual(["ended", "canceled"]);
    expect(chain.balances.get(MERCHANT)).toBe(merchantBefore); // no renewal pull
    expect(await credits("k1")).toBe("10");
  });

  test("closing the subscription authority ends the subscription", async () => {
    const { subscriptionId, wallet } = await subscribe("k2", usdc("20"));
    chain.closeAuthority(wallet);
    await reconcileAll(db, chains());
    expect((await sub(subscriptionId)).endedReason).toBe("authority_closed");
  });
});

describe("sending safely", () => {
  test("a dropped transaction is not replaced until its blockhash expires", async () => {
    const { subscriptionId } = await subscribe("s1", usdc("20"));
    await track(db, scope, { customerId: "s1", featureId: "message", value: "300" }); // 2 USDC
    chain.sendModes.push("drop");
    await tick();
    const attempts = () => db.select().from(settlementAttempts).where(and(eq(settlementAttempts.subscriptionId, subscriptionId)));
    expect((await attempts()).map((a) => a.status)).toEqual(["confirmed", "pending"]);
    await tick(); // still within the blockhash lifetime: no second transaction
    expect(await attempts()).toHaveLength(2);
    chain.advance(90_000); // past lastValidBlockHeight
    await tick();
    expect((await attempts()).map((a) => a.status).sort()).toEqual(["confirmed", "confirmed", "expired"]);
    expect(chain.transfers.filter((t) => t.amount === usdc("2")).length).toBe(2); // activation + one overage pull
    await expectNoDrift();
  });

  test("a send that times out but lands is counted once", async () => {
    const { subscriptionId } = await subscribe("s2", usdc("20"));
    await track(db, scope, { customerId: "s2", featureId: "message", value: "300" });
    chain.sendModes.push("timeout_lands");
    await tick();
    await tick();
    const inv = await invoicesOf(subscriptionId);
    expect(inv.at(-1)).toMatchObject({ kind: "overage", status: "paid", amountPaid: usdc("2") });
    expect(chain.transfers).toHaveLength(2);
    await expectNoDrift();
  });
});

describe("webhooks", () => {
  test("events are signed and delivered, and failures retry with backoff", async () => {
    // The dispatcher serves every org, so this test only looks at deliveries to its own URL.
    const url = `https://merchant.test/hooks/${scope.orgId}`;
    const { secret } = await setWebhookEndpoint(db, scope, url);
    await subscribe("w1", usdc("10"));
    const got: { body: string; sig: string }[] = [];
    let fail = true;
    let failed = 0;
    const stub: typeof fetch = async (to, init) => {
      if (String(to) !== url) return new Response("ok");
      if (fail) {
        failed++;
        return new Response("nope", { status: 500 });
      }
      got.push({ body: String(init!.body), sig: new Headers(init!.headers).get("x-nummo-signature")! });
      return new Response("ok");
    };
    // Outbox rows are timestamped by Postgres, so dispatch runs on wall-clock time.
    await dispatchWebhooks(db, { now: new Date(), fetch: stub });
    expect(failed).toBeGreaterThan(0);
    fail = false;
    await dispatchWebhooks(db, { now: new Date(), fetch: stub });
    expect(got).toHaveLength(0); // backing off
    await dispatchWebhooks(db, { now: new Date(Date.now() + 60_000), fetch: stub });
    expect(got).toHaveLength(failed);
    const types = got.map((g) => JSON.parse(g.body).type);
    expect(types).toEqual(expect.arrayContaining(["subscription.activated", "payment.succeeded"]));
    for (const g of got) {
      const t = Number(/t=(\d+)/.exec(g.sig)![1]);
      expect(g.sig).toBe(signPayload(secret, g.body, t));
    }
  });
});
