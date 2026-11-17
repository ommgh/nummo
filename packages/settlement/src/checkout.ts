/**
 * Hosted checkout (doc 03, "Activation: one signature").
 *
 *   1. `attach` created a pending subscription and this checkout session.
 *   2. The page connects a wallet and shows the plan terms read from the chain.
 *   3. We build one transaction: [init authority] + subscribe + first pull, with
 *      the puller as fee payer, so the customer needs USDC and no SOL.
 *   4. The wallet signs it and hands it back without broadcasting.
 *   5. We check it is byte for byte what we built, co-sign, record the attempt,
 *      and broadcast.
 *   6. On confirmation the subscription activates, the plan's grants are issued,
 *      and the invoice and payment are written.
 *
 * The session id is the only credential the checkout routes take, like a
 * payment link, so it is long and random.
 */

import { and, eq, sql } from "drizzle-orm";
import { describePeriod, formatBaseUnits } from "@usenummo/core";
import {
  activateSubscription,
  type Db,
  emit,
  endSubscription,
  inCustomerTx,
  newId,
  NummoError,
  schema,
  type Scope,
} from "@usenummo/db";
import { ActivationRejected, type Chain } from "@usenummo/solana";
import type { Chains } from "./chains.ts";
import { describeFailure, outcomeOf, waitForOutcome } from "./confirm.ts";
import type { SettlementSettings } from "./settings.ts";

const { checkoutSessions, invoiceLines, invoices, orgs, payments, planVersions, settlementAttempts } = schema;

type Session = typeof checkoutSessions.$inferSelect;

async function loadSession(db: Db, id: string) {
  const [row] = await db
    .select({ s: checkoutSessions, pv: planVersions, org: orgs })
    .from(checkoutSessions)
    .innerJoin(planVersions, eq(planVersions.id, checkoutSessions.planVersionId))
    .innerJoin(orgs, eq(orgs.id, checkoutSessions.orgId))
    .where(eq(checkoutSessions.id, id));
  if (!row) throw new NummoError("checkout_not_found", "checkout not found");
  return row;
}

function chainFor(chains: Chains, scope: Scope): Chain {
  const c = chains[scope.env];
  if (!c) throw new NummoError("settlement_unavailable", `settlement is not configured for the ${scope.env} environment`);
  return c;
}

const scopeOf = (s: Session): Scope => ({ orgId: s.orgId, env: s.env });

/** Mark an open session past its expiry as expired, and drop its pending subscription. */
async function expireIfDue(db: Db, s: Session, now: Date): Promise<Session> {
  if (s.status !== "open" || s.expiresAt > now) return s;
  await inCustomerTx(
    db,
    scopeOf(s),
    s.customerId,
    async (ctx) => {
      const [u] = await ctx.tx
        .update(checkoutSessions)
        .set({ status: "expired" })
        .where(and(eq(checkoutSessions.id, s.id), eq(checkoutSessions.status, "open")))
        .returning();
      if (u) await endSubscription(ctx, s.subscriptionId, "checkout_expired");
    },
    { create: false },
  );
  return { ...s, status: "expired" };
}

/** What the checkout page shows. Price, period and ceiling are read from the chain, not our database. */
export async function getCheckout(db: Db, chains: Chains, id: string, now = new Date()) {
  const row = await loadSession(db, id);
  const s = await expireIfDue(db, row.s, now);
  const chain = chainFor(chains, scopeOf(s));
  const plan = row.pv.onchainPlanPda ? await chain.getPlan(row.pv.onchainPlanPda) : null;
  return {
    id: s.id,
    status: s.status,
    merchant: row.org.name,
    plan: { id: row.pv.planId, name: row.pv.name, version: row.pv.version },
    network: chain.network,
    mint: chain.mint,
    firstCharge: formatBaseUnits(s.amount),
    onchain: plan
      ? {
          address: plan.address,
          ceiling: formatBaseUnits(plan.amount),
          periodHours: plan.periodHours,
          period: describePeriod(plan.periodHours),
          status: plan.status,
        }
      : null,
    wallet: s.wallet,
    signature: s.signature,
    error: s.error,
    successUrl: s.status === "completed" ? s.successUrl : null,
    expiresAt: s.expiresAt.toISOString(),
  };
}

/** Build the activation transaction for the connected wallet. Returns it unsigned, base64. */
export async function prepareCheckoutTransaction(db: Db, chains: Chains, id: string, wallet: string, now = new Date()) {
  const row = await loadSession(db, id);
  const s = await expireIfDue(db, row.s, now);
  if (s.status !== "open") throw new NummoError("checkout_closed", `this checkout is ${s.status}`);
  const chain = chainFor(chains, scopeOf(s));
  if (chain.network !== "fake" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    throw new NummoError("invalid_request", "wallet must be a base58 Solana address");
  }

  const plan = row.pv.onchainPlanPda ? await chain.getPlan(row.pv.onchainPlanPda) : null;
  if (!plan || plan.status !== "active" || plan.amount !== row.pv.ceilingAmount) {
    throw new NummoError("checkout_closed", "the on-chain plan for this checkout is missing or no longer active");
  }
  const balance = await chain.getTokenBalance(wallet);
  if (balance === null) throw new NummoError("wallet_not_ready", "This wallet has no USDC account. Receive some USDC first.");
  if (balance < s.amount) {
    throw new NummoError("wallet_not_ready", `This wallet holds ${formatBaseUnits(balance)} USDC; the first charge is ${formatBaseUnits(s.amount)} USDC.`);
  }
  const existing = await chain.getSubscription(await chain.findSubscriptionAddress(plan.address, wallet));
  if (existing) {
    // One subscription per plan per wallet (doc 03, fact 10).
    throw new NummoError("wallet_not_ready", "This wallet already has a subscription to this plan. Use another wallet.");
  }

  const built = await chain.buildActivation({ plan, subscriber: wallet, firstPull: s.amount });
  await db
    .update(checkoutSessions)
    .set({ wallet, message: built.message, lastValidBlockHeight: built.lastValidBlockHeight, error: null })
    .where(and(eq(checkoutSessions.id, id), eq(checkoutSessions.status, "open")));
  return { transaction: built.transaction, createsAuthority: built.createsAuthority, lastValidBlockHeight: built.lastValidBlockHeight.toString() };
}

/**
 * Take the wallet-signed transaction, verify it, co-sign, record, broadcast,
 * and wait briefly for confirmation. If it is still in flight when the wait
 * ends, the worker finishes the job.
 */
export async function submitCheckout(db: Db, chains: Chains, settings: SettlementSettings, id: string, signedTransaction: string) {
  const row = await loadSession(db, id);
  const s = row.s;
  if (s.status !== "open") throw new NummoError("checkout_closed", `this checkout is ${s.status}`);
  if (!s.message || !s.wallet || s.lastValidBlockHeight === null) {
    throw new NummoError("invalid_request", "connect a wallet and request the transaction first");
  }
  const chain = chainFor(chains, scopeOf(s));
  if ((await chain.getBlockHeight()) > s.lastValidBlockHeight) {
    throw new NummoError("activation_rejected", "The transaction expired before it was signed. Sign again.");
  }

  let prepared;
  try {
    prepared = await chain.cosignActivation(signedTransaction, s.message, s.wallet, s.lastValidBlockHeight);
  } catch (e) {
    if (e instanceof ActivationRejected) throw new NummoError("activation_rejected", e.message);
    throw e;
  }

  // Record before broadcasting. The conditional update makes a double submit lose the race cleanly.
  const recorded = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(checkoutSessions)
      .set({ status: "submitted", signature: prepared.signature, error: null })
      .where(and(eq(checkoutSessions.id, id), eq(checkoutSessions.status, "open")))
      .returning();
    if (!u) return false;
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(settlementAttempts)
      .where(eq(settlementAttempts.checkoutSessionId, id))) as [{ n: number }];
    await tx.insert(settlementAttempts).values({
      id: newId("att"),
      ...scopeOf(s),
      subscriptionId: s.subscriptionId,
      checkoutSessionId: id,
      attempt: n + 1,
      signature: prepared.signature,
      amount: s.amount,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
    return true;
  });
  if (!recorded) throw new NummoError("checkout_closed", "this checkout was already submitted");

  const sent = await chain.send(prepared);
  if (!sent.ok && sent.definite) {
    await settleCheckoutAttempt(db, chain, id, { state: "failed", error: sent.error });
  } else {
    const outcome = await waitForOutcome(chain, prepared.signature, prepared.lastValidBlockHeight, settings.confirmWaitMs, settings.pollMs);
    await settleCheckoutAttempt(db, chain, id, outcome);
  }
  return getCheckout(db, chains, id);
}

/** Worker: finish checkouts whose transaction was still in flight when the request returned. */
export async function resolveSubmittedCheckouts(db: Db, chains: Chains, now = new Date()) {
  const rows = await db.select().from(checkoutSessions).where(eq(checkoutSessions.status, "submitted"));
  for (const s of rows) {
    const chain = chains[s.env];
    if (!chain || !s.signature || s.lastValidBlockHeight === null) continue;
    const [att] = await db
      .select()
      .from(settlementAttempts)
      .where(and(eq(settlementAttempts.signature, s.signature)));
    if (!att) continue;
    await settleCheckoutAttempt(db, chain, s.id, await outcomeOf(chain, att.signature, att.lastValidBlockHeight));
  }
  // Expire abandoned checkouts.
  const stale = await db
    .select()
    .from(checkoutSessions)
    .where(and(eq(checkoutSessions.status, "open"), sql`${checkoutSessions.expiresAt} <= ${now}`));
  for (const s of stale) await expireIfDue(db, s, now);
}

/** Apply a known outcome to a submitted checkout. Safe to call twice: only a pending attempt changes. */
async function settleCheckoutAttempt(db: Db, chain: Chain, id: string, outcome: Awaited<ReturnType<typeof outcomeOf>>) {
  if (outcome.state === "pending") return;
  const row = await loadSession(db, id);
  const s = row.s;
  if (s.status !== "submitted" || !s.signature || !s.wallet) return;

  // Read the new on-chain record outside the transaction: its period start anchors our periods.
  let onchain = null;
  if (outcome.state === "confirmed") {
    const address = await chain.findSubscriptionAddress(row.pv.onchainPlanPda!, s.wallet);
    onchain = await chain.getSubscription(address);
    if (!onchain) return; // not visible yet at this RPC node; try again next tick
  }

  await inCustomerTx(
    db,
    scopeOf(s),
    s.customerId,
    async (ctx) => {
      const [att] = await ctx.tx
        .select()
        .from(settlementAttempts)
        .where(and(eq(settlementAttempts.signature, s.signature!), eq(settlementAttempts.status, "pending")))
        .for("update");
      if (!att) return;

      if (outcome.state !== "confirmed") {
        const error =
          outcome.state === "expired" ? "The transaction expired before it landed. Sign again." : describeFailure(outcome.error);
        await ctx.tx
          .update(settlementAttempts)
          .set({
            status: outcome.state === "expired" ? "expired" : "failed",
            resolvedAt: ctx.now,
            ...(outcome.state === "failed" ? { errorKind: outcome.error.kind, errorCode: outcome.error.code, error: outcome.error.message } : {}),
          })
          .where(eq(settlementAttempts.id, att.id));
        // The customer can try again, with this wallet or another.
        await ctx.tx
          .update(checkoutSessions)
          .set({ status: "open", signature: null, message: null, error })
          .where(eq(checkoutSessions.id, id));
        return;
      }

      const anchor = onchain!.currentPeriodStart;
      await activateSubscription(ctx, { subscriptionId: s.subscriptionId, wallet: s.wallet!, subscriptionPda: onchain!.address, periodAnchor: anchor });
      const invoiceId = newId("inv");
      await ctx.tx.insert(invoices).values({
        id: invoiceId,
        ...ctx.scope,
        customerId: s.customerId,
        subscriptionId: s.subscriptionId,
        kind: "activation",
        periodStart: anchor,
        total: s.amount,
        amountPaid: s.amount,
        status: "paid",
        paidAt: ctx.now,
      });
      if (s.amount > 0n) {
        await ctx.tx.insert(invoiceLines).values({ id: newId("il"), invoiceId, kind: "base", amount: s.amount });
        await ctx.tx.insert(payments).values({
          id: newId("pay"),
          ...ctx.scope,
          customerId: s.customerId,
          subscriptionId: s.subscriptionId,
          invoiceId,
          signature: att.signature,
          amount: s.amount,
          status: outcome.finalized ? "finalized" : "confirmed",
          finalizedAt: outcome.finalized ? ctx.now : null,
        });
      }
      await ctx.tx
        .update(settlementAttempts)
        .set({ status: "confirmed", invoiceId, onchainPeriodStart: anchor, resolvedAt: ctx.now })
        .where(eq(settlementAttempts.id, att.id));
      await ctx.tx.update(checkoutSessions).set({ status: "completed", completedAt: ctx.now }).where(eq(checkoutSessions.id, id));
      await emit(ctx.tx, ctx.scope, "invoice.finalized", { invoiceId, subscriptionId: s.subscriptionId, customerId: s.customerId, kind: "activation", total: formatBaseUnits(s.amount) });
      if (s.amount > 0n) {
        await emit(ctx.tx, ctx.scope, "payment.succeeded", {
          invoiceId,
          subscriptionId: s.subscriptionId,
          customerId: s.customerId,
          amount: formatBaseUnits(s.amount),
          signature: att.signature,
        });
      }
    },
    { create: false },
  );
}
