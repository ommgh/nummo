/**
 * Hosted checkout (doc 03, "Activation: one signature", "Plan changes", "One-off purchases").
 *
 * One flow for three kinds of session:
 *
 *   subscribe  [init authority] + subscribe + first pull (the base fee)
 *   change     subscribe to the new plan + the prorated first pull + cancel the
 *              old subscription, signed by the wallet that pays for the old plan
 *   topup      a plain token transfer to the merchant with a reference key
 *
 * In every case the server builds the transaction with the puller as fee payer
 * (the customer needs no SOL), the wallet signs it without broadcasting, and the
 * server checks it is byte for byte what it built, co-signs, records the
 * attempt, and broadcasts. On confirmation the subscription activates (and the
 * one it replaces winds down), or the purchased balance is granted, and the
 * invoice and payment are written.
 *
 * The session id is the only credential the checkout routes take, like a
 * payment link, so it is long and random.
 */

import { and, eq, sql } from "drizzle-orm";
import { describePeriod, formatBaseUnits, formatQty, qty } from "@usenummo/core";
import {
  activateSubscription,
  type Db,
  emit,
  endSubscription,
  grantTopUp,
  inCustomerTx,
  liveSubscriptions,
  newId,
  NummoError,
  quotePlanChange,
  schema,
  type Scope,
} from "@usenummo/db";
import { ActivationRejected, type Chain, type OnchainSubscription } from "@usenummo/solana";
import type { Chains } from "./chains.ts";
import { describeFailure, outcomeOf, waitForOutcome } from "./confirm.ts";
import type { SettlementSettings } from "./settings.ts";

const { checkoutSessions, features, invoiceLines, invoices, orgs, payments, planVersions, settlementAttempts, subscriptions } = schema;

type Session = typeof checkoutSessions.$inferSelect;
type PlanVersion = typeof planVersions.$inferSelect;

async function loadSession(db: Db, id: string) {
  const [row] = await db
    .select({ s: checkoutSessions, pv: planVersions, org: orgs })
    .from(checkoutSessions)
    .leftJoin(planVersions, eq(planVersions.id, checkoutSessions.planVersionId))
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
      if (u && s.subscriptionId) await endSubscription(ctx, s.subscriptionId, "checkout_expired");
    },
    { create: false },
  );
  return { ...s, status: "expired" };
}

/** The subscription a change replaces, with its plan version. */
async function replacedRow(db: Db, s: Session) {
  if (!s.replacesSubscriptionId) return null;
  const [row] = await db
    .select({ sub: subscriptions, pv: planVersions })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .where(eq(subscriptions.id, s.replacesSubscriptionId));
  return row ?? null;
}

/** What the checkout page shows. Price, period and ceiling are read from the chain, not our database. */
export async function getCheckout(db: Db, chains: Chains, id: string, now = new Date()) {
  const row = await loadSession(db, id);
  const s = await expireIfDue(db, row.s, now);
  const chain = chainFor(chains, scopeOf(s));
  const pv = row.pv;
  const plan = pv?.onchainPlanPda ? await chain.getPlan(pv.onchainPlanPda) : null;
  const old = s.kind === "change" ? await replacedRow(db, s) : null;
  const proration = s.proration as { credit: string } | null;
  let feature: { id: string; name: string | null } | null = null;
  if (s.kind === "topup" && s.featureId) {
    const [f] = await db
      .select({ id: features.id, name: features.name })
      .from(features)
      .where(and(eq(features.orgId, s.orgId), eq(features.env, s.env), eq(features.id, s.featureId)));
    feature = f ?? { id: s.featureId, name: null };
  }
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    merchant: row.org.name,
    plan: pv ? { id: pv.planId, name: pv.name, version: pv.version } : null,
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
    change: old
      ? {
          from: { id: old.pv.planId, name: old.pv.name, version: old.pv.version },
          credit: formatBaseUnits(BigInt(proration?.credit ?? "0")),
        }
      : null,
    // The reference key rides on the transfer so the payment can be found on-chain (Solana Pay convention).
    topup: s.kind === "topup" ? { feature, quantity: s.quantity === null ? null : formatQty(qty(s.quantity)), payTo: s.payTo, reference: s.reference } : null,
    /** A change must be signed by the wallet that pays for the current plan. */
    requiredWallet: s.kind === "change" ? s.wallet : null,
    wallet: s.wallet,
    signature: s.signature,
    error: s.error,
    successUrl: s.status === "completed" ? s.successUrl : null,
    expiresAt: s.expiresAt.toISOString(),
  };
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Build the transaction for the connected wallet. Returns it unsigned, base64. */
export async function prepareCheckoutTransaction(db: Db, chains: Chains, id: string, wallet: string, now = new Date()) {
  const row = await loadSession(db, id);
  const s = await expireIfDue(db, row.s, now);
  if (s.status !== "open") throw new NummoError("checkout_closed", `this checkout is ${s.status}`);
  const chain = chainFor(chains, scopeOf(s));
  if (chain.network !== "fake" && !BASE58.test(wallet)) {
    throw new NummoError("invalid_request", "wallet must be a base58 Solana address");
  }

  if (s.kind === "topup") return prepareTopUp(db, chain, s, wallet);

  const pv = row.pv!;
  const plan = pv.onchainPlanPda ? await chain.getPlan(pv.onchainPlanPda) : null;
  if (!plan || plan.status !== "active" || plan.amount !== pv.ceilingAmount) {
    throw new NummoError("checkout_closed", "the on-chain plan for this checkout is missing or no longer active");
  }

  let amount = s.amount;
  let cancel: { plan: string } | undefined;
  let proration = s.proration;
  if (s.kind === "change") {
    if (wallet !== s.wallet) {
      throw new NummoError("wrong_wallet", `Sign with the wallet that pays for your current plan: ${s.wallet}`);
    }
    const quoted = await quoteChange(db, s, pv);
    amount = quoted.amount;
    proration = quoted.proration;
    cancel = quoted.cancel;
  }

  const balance = await chain.getTokenBalance(wallet);
  if (balance === null) throw new NummoError("wallet_not_ready", "This wallet has no USDC account. Receive some USDC first.");
  if (balance < amount) {
    throw new NummoError("wallet_not_ready", `This wallet holds ${formatBaseUnits(balance)} USDC; ${formatBaseUnits(amount)} USDC is due now.`);
  }
  const existing = await chain.getSubscription(await chain.findSubscriptionAddress(plan.address, wallet));
  if (existing) {
    // One subscription per plan per wallet (doc 03, fact 10).
    throw new NummoError("wallet_not_ready", "This wallet already has a subscription to this plan. Use another wallet.");
  }

  const built = await chain.buildActivation({ plan, subscriber: wallet, firstPull: amount, cancel });
  await db
    .update(checkoutSessions)
    .set({ wallet, amount, proration, message: built.message, lastValidBlockHeight: built.lastValidBlockHeight, error: null })
    .where(and(eq(checkoutSessions.id, id), eq(checkoutSessions.status, "open")));
  return {
    transaction: built.transaction,
    createsAuthority: built.createsAuthority,
    amount: formatBaseUnits(amount),
    lastValidBlockHeight: built.lastValidBlockHeight.toString(),
  };
}

/**
 * Re-price a plan change at signing time: the credit shrinks as the old period
 * runs on, and the old subscription may have changed since `attach`.
 */
async function quoteChange(db: Db, s: Session, pv: PlanVersion) {
  return inCustomerTx(
    db,
    scopeOf(s),
    s.customerId,
    async (ctx) => {
      const old = (await liveSubscriptions(ctx)).find((l) => l.sub.id === s.replacesSubscriptionId);
      if (!old) throw new NummoError("checkout_closed", "the plan this checkout replaces is no longer active");
      const q = await quotePlanChange(ctx, old, pv);
      if (q.direction !== "upgrade") throw new NummoError("checkout_closed", "this change now takes effect at the period end; start it again");
      return {
        amount: q.dueNow,
        proration: { credit: q.credit.toString(), dueNow: q.dueNow.toString(), periodStart: q.periodStart.toISOString(), periodEnd: q.periodEnd.toISOString() },
        // Already cancelled on-chain (from the portal or a wallet): nothing to cancel again.
        cancel: old.sub.cancelAt ? undefined : { plan: old.pv.onchainPlanPda! },
      };
    },
    { create: false },
  );
}

async function prepareTopUp(db: Db, chain: Chain, s: Session, wallet: string) {
  const balance = await chain.getTokenBalance(wallet);
  if (balance === null) throw new NummoError("wallet_not_ready", "This wallet has no USDC account. Receive some USDC first.");
  if (balance < s.amount) {
    throw new NummoError("wallet_not_ready", `This wallet holds ${formatBaseUnits(balance)} USDC; the top-up is ${formatBaseUnits(s.amount)} USDC.`);
  }
  if ((await chain.getTokenBalance(s.payTo!)) === null) {
    throw new NummoError("checkout_closed", "the merchant's wallet cannot receive USDC yet");
  }
  const built = await chain.buildTransfer({ from: wallet, to: s.payTo!, amount: s.amount, reference: s.reference! });
  await db
    .update(checkoutSessions)
    .set({ wallet, message: built.message, lastValidBlockHeight: built.lastValidBlockHeight, error: null })
    .where(and(eq(checkoutSessions.id, s.id), eq(checkoutSessions.status, "open")));
  return {
    transaction: built.transaction,
    createsAuthority: false,
    amount: formatBaseUnits(s.amount),
    lastValidBlockHeight: built.lastValidBlockHeight.toString(),
  };
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
    prepared = await chain.cosign(signedTransaction, s.message, s.wallet, s.lastValidBlockHeight);
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
    const [att] = await db.select().from(settlementAttempts).where(and(eq(settlementAttempts.signature, s.signature)));
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

  // Read the new on-chain records outside the transaction: the new period start anchors our periods,
  // and the replaced subscription's end time is when it stops being collectable.
  let onchain: OnchainSubscription | null = null;
  let oldOnchain: OnchainSubscription | null = null;
  if (outcome.state === "confirmed" && s.kind !== "topup") {
    onchain = await chain.getSubscription(await chain.findSubscriptionAddress(row.pv!.onchainPlanPda!, s.wallet));
    if (!onchain) return; // not visible yet at this RPC node; try again next tick
    if (s.kind === "change") {
      const old = await replacedRow(db, s);
      oldOnchain = old?.sub.subscriptionPda ? await chain.getSubscription(old.sub.subscriptionPda) : null;
    }
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
        // The customer can try again, with this wallet or another (a change keeps its wallet).
        await ctx.tx
          .update(checkoutSessions)
          .set({ status: "open", signature: null, message: null, error })
          .where(eq(checkoutSessions.id, id));
        return;
      }

      const invoiceId = newId("inv");
      const lines: (typeof invoiceLines.$inferInsert)[] = [];
      let periodStart: Date;

      if (s.kind === "topup") {
        periodStart = ctx.now;
        lines.push({ id: newId("il"), invoiceId, kind: "topup", featureId: s.featureId, quantity: s.quantity, amount: s.amount });
        await grantTopUp(ctx, s.featureId!, s.quantity!);
      } else {
        periodStart = onchain!.currentPeriodStart;
        const credit = BigInt((s.proration as { credit?: string } | null)?.credit ?? "0");
        await activateSubscription(ctx, {
          subscriptionId: s.subscriptionId!,
          wallet: s.wallet!,
          subscriptionPda: onchain!.address,
          periodAnchor: periodStart,
          windDown:
            s.kind === "change" && s.replacesSubscriptionId
              ? {
                  subscriptionId: s.replacesSubscriptionId,
                  // The cancel in this transaction set the old record's end; if it was already cancelled, that end stands.
                  cancelAt: oldOnchain?.expiresAt ?? ctx.now,
                }
              : undefined,
        });
        if (s.kind === "change") {
          lines.push({ id: newId("il"), invoiceId, kind: "base", amount: row.pv!.baseAmount });
          if (credit > 0n) lines.push({ id: newId("il"), invoiceId, kind: "proration", amount: -credit });
        } else if (s.amount > 0n) {
          lines.push({ id: newId("il"), invoiceId, kind: "base", amount: s.amount });
        }
      }

      await ctx.tx.insert(invoices).values({
        id: invoiceId,
        ...ctx.scope,
        customerId: s.customerId,
        subscriptionId: s.subscriptionId,
        kind: s.kind === "topup" ? "topup" : "activation",
        periodStart,
        total: s.amount,
        amountPaid: s.amount,
        status: "paid",
        paidAt: ctx.now,
      });
      if (lines.length) await ctx.tx.insert(invoiceLines).values(lines);
      if (s.amount > 0n) {
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
        .set({ status: "confirmed", invoiceId, onchainPeriodStart: s.kind === "topup" ? null : periodStart, resolvedAt: ctx.now })
        .where(eq(settlementAttempts.id, att.id));
      await ctx.tx.update(checkoutSessions).set({ status: "completed", completedAt: ctx.now }).where(eq(checkoutSessions.id, id));
      const kind = s.kind === "topup" ? "topup" : "activation";
      await emit(ctx.tx, ctx.scope, "invoice.finalized", {
        invoiceId,
        subscriptionId: s.subscriptionId,
        customerId: s.customerId,
        kind,
        total: formatBaseUnits(s.amount),
        ...(s.kind === "topup" ? { featureId: s.featureId, quantity: formatQty(qty(s.quantity!)) } : {}),
      });
      if (s.amount > 0n) {
        await emit(ctx.tx, ctx.scope, "payment.succeeded", {
          invoiceId,
          subscriptionId: s.subscriptionId,
          customerId: s.customerId,
          kind,
          amount: formatBaseUnits(s.amount),
          signature: att.signature,
        });
      }
    },
    { create: false },
  );
}
