/**
 * The settlement worker (doc 03, "Collecting each period" and "When a pull fails").
 *
 * For each live paid subscription, one pass:
 *
 *   1. Resolve any transaction still in flight. While one is unresolved, do
 *      nothing else for this subscription: a second transaction for the same
 *      invoice could land too and charge the customer twice.
 *   2. Read the on-chain record and apply what the customer did there
 *      (cancel, resume, revoke) before pulling anything.
 *   3. Write invoices: the base fee at each period boundary, and accrued
 *      overage once it reaches the threshold or the period is about to end.
 *   4. Pull the oldest open invoice, cut to what the on-chain ceiling has
 *      left, unless a failed payment is waiting for its next retry.
 *
 * Network calls never happen inside a database transaction. Every state change
 * happens under the customer's row lock (`inCustomerTx`), the same lock `track`
 * takes, so usage and billing never interleave.
 */

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { formatBaseUnits, HOUR_MS, periodAt } from "@usenummo/core";
import {
  type CustomerCtx,
  type Db,
  emit,
  endSubscription,
  type Env,
  grantTopUp,
  inCustomerTx,
  newId,
  schema,
  type Scope,
  subPayload,
} from "@usenummo/db";
import type { Chain, ChainError, OnchainAuthority, OnchainPlan, OnchainSubscription } from "@usenummo/solana";
import type { Chains } from "./chains.ts";
import { describeFailure, type Outcome, outcomeOf, waitForOutcome } from "./confirm.ts";
import type { SettlementSettings } from "./settings.ts";

const { accruals, invoiceLines, invoices, payments, planVersions, settlementAttempts, subscriptions } = schema;

type SubRow = typeof subscriptions.$inferSelect;
type PvRow = typeof planVersions.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;

export type TickReport = { subscriptions: number; pulls: number; errors: { subscriptionId: string; error: string }[] };

const scopeOf = (s: { orgId: string; env: Env }): Scope => ({ orgId: s.orgId, env: s.env });

function withCustomer<T>(db: Db, sub: SubRow, fn: (ctx: CustomerCtx) => Promise<T>) {
  return inCustomerTx(db, scopeOf(sub), sub.customerId, fn, { create: false });
}

async function reloadSub(ctx: CustomerCtx, id: string) {
  const [row] = await ctx.tx.select().from(subscriptions).where(eq(subscriptions.id, id));
  return row!;
}

/** Live paid subscriptions with a wallet, in one environment. */
export async function settleableSubscriptions(db: Db, env: Env) {
  return db
    .select({ sub: subscriptions, pv: planVersions })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .where(
      and(
        eq(subscriptions.env, env),
        inArray(subscriptions.status, ["active", "past_due", "canceling"]),
        isNotNull(planVersions.ceilingAmount),
        isNotNull(subscriptions.wallet),
        isNotNull(subscriptions.subscriptionPda),
      ),
    );
}

/** One worker pass over every environment that has a chain. */
export async function settleAll(db: Db, chains: Chains, settings: SettlementSettings, now: Date): Promise<TickReport> {
  const report: TickReport = { subscriptions: 0, pulls: 0, errors: [] };
  for (const env of ["test", "live"] as const) {
    const chain = chains[env];
    if (!chain) continue;
    const plans = new Map<string, OnchainPlan | null>();
    for (const { sub, pv } of await settleableSubscriptions(db, env)) {
      report.subscriptions++;
      try {
        if (await settleSubscription(db, chain, settings, sub, pv, now, plans)) report.pulls++;
      } catch (e) {
        report.errors.push({ subscriptionId: sub.id, error: (e as Error).message });
      }
    }
    try {
      await finalizePayments(db, chain, env, now);
    } catch (e) {
      report.errors.push({ subscriptionId: "(finality check)", error: (e as Error).message });
    }
  }
  return report;
}

/** Returns true if a pull was sent. */
export async function settleSubscription(
  db: Db,
  chain: Chain,
  settings: SettlementSettings,
  sub: SubRow,
  pv: PvRow,
  now: Date,
  planCache = new Map<string, OnchainPlan | null>(),
): Promise<boolean> {
  // 1. Anything in flight?
  const pending = await db
    .select()
    .from(settlementAttempts)
    .where(and(eq(settlementAttempts.subscriptionId, sub.id), eq(settlementAttempts.status, "pending"), isNotNull(settlementAttempts.invoiceId)));
  for (const att of pending) {
    const o = await outcomeOf(chain, att.signature, att.lastValidBlockHeight);
    if (o.state === "pending") return false;
    await applyPullOutcome(db, chain, settings, att.id, o);
  }

  const [current] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
  if (!current || current.status === "ended") return false;

  // 2. Endings already known from the chain, a scheduled downgrade, or the retry schedule.
  if (current.cancelAt && now >= current.cancelAt) {
    await withCustomer(db, current, (ctx) => endSubscription(ctx, current.id, current.replacedBy ? "replaced" : "canceled"));
    return false;
  }
  if (current.scheduledAt && now >= current.scheduledAt) {
    // Not renewed: the scheduled plan takes over (endSubscription starts it).
    await withCustomer(db, current, (ctx) => endSubscription(ctx, current.id, "downgraded"));
    return false;
  }
  if (current.status === "past_due" && current.nextRetryAt === null && current.pastDueSince) {
    // No retry left (a frozen account): end when the grace period does.
    const graceEnd = current.pastDueSince.getTime() + settings.retrySchedule.at(-1)!;
    if (now.getTime() >= graceEnd) {
      await withCustomer(db, current, (ctx) => endSubscription(ctx, current.id, "payment_failed"));
      return false;
    }
  }

  // 3. Invoices.
  await writeInvoices(db, settings, current, pv, now);

  // 4. Collect the oldest open invoice.
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, "open")))
    .orderBy(asc(invoices.createdAt))
    .limit(1);
  if (!invoice) return false;
  if (current.status === "past_due" && (current.nextRetryAt === null || current.nextRetryAt > now)) return false;

  // Read the subscriber record and the plan before every pull (doc 03, "Reconciliation").
  const onchain = await chain.getSubscription(current.subscriptionPda!);
  const authority = onchain ? await chain.getAuthority(current.wallet!) : null;
  const fresh = await applyOnchainState(db, current, onchain, authority);
  if (!fresh || fresh.status === "ended" || !onchain) return false;
  if (fresh.cancelAt && now >= fresh.cancelAt) return false;

  if (!planCache.has(pv.onchainPlanPda!)) planCache.set(pv.onchainPlanPda!, await chain.getPlan(pv.onchainPlanPda!));
  const plan = planCache.get(pv.onchainPlanPda!);
  if (!plan) return false;
  return collect(db, chain, settings, fresh, plan, onchain, invoice, now);
}

// ------------------------------------------------------------------ on-chain state

/**
 * Reconcile one subscription with its on-chain record (doc 03, "Reconciliation").
 * Returns the updated row, or null if it ended.
 */
export async function applyOnchainState(db: Db, sub: SubRow, onchain: OnchainSubscription | null, authority: OnchainAuthority | null) {
  return withCustomer(db, sub, async (ctx) => {
    const s = await reloadSub(ctx, sub.id);
    if (s.status === "ended" || s.status === "pending") return s;

    if (!onchain) {
      await endSubscription(ctx, s.id, "revoked");
      return null;
    }
    // A closed or re-created authority leaves the record abandoned: pulls can never succeed again.
    if (!authority || authority.initId !== onchain.initId) {
      await endSubscription(ctx, s.id, "authority_closed");
      return null;
    }
    if (onchain.expiresAt) {
      if (ctx.now >= onchain.expiresAt) {
        if (s.cancelAt?.getTime() !== onchain.expiresAt.getTime()) {
          await ctx.tx.update(subscriptions).set({ cancelAt: onchain.expiresAt }).where(eq(subscriptions.id, s.id));
        }
        await endSubscription(ctx, s.id, "canceled");
        return null;
      }
      if (s.cancelAt?.getTime() !== onchain.expiresAt.getTime()) {
        const [u] = await ctx.tx
          .update(subscriptions)
          .set({ cancelAt: onchain.expiresAt, status: s.status === "active" ? "canceling" : s.status })
          .where(eq(subscriptions.id, s.id))
          .returning();
        await emit(ctx.tx, ctx.scope, "subscription.canceled", subPayload(u!, { endsAt: onchain.expiresAt.toISOString() }));
        return u!;
      }
    } else if (s.cancelAt !== null) {
      const [u] = await ctx.tx
        .update(subscriptions)
        .set({ cancelAt: null, status: s.status === "canceling" ? "active" : s.status })
        .where(eq(subscriptions.id, s.id))
        .returning();
      await emit(ctx.tx, ctx.scope, "subscription.resumed", subPayload(u!));
      return u!;
    }
    return s;
  });
}

// ------------------------------------------------------------------ invoices

async function addLinesFromAccruals(ctx: CustomerCtx, subscriptionId: string, invoiceId: string) {
  const rows = await ctx.tx
    .select()
    .from(accruals)
    .where(and(eq(accruals.subscriptionId, subscriptionId), sql`${accruals.amount} > ${accruals.invoiced}`));
  let total = 0n;
  for (const a of rows) {
    const amount = a.amount - a.invoiced;
    await ctx.tx.insert(invoiceLines).values({
      id: newId("il"),
      invoiceId,
      kind: "overage",
      featureId: a.featureId,
      quantity: sql`${a.billableUnits}::numeric - ${a.invoicedUnits}::numeric`,
      amount,
      accrualId: a.id,
    });
    await ctx.tx
      .update(accruals)
      .set({ invoiced: a.amount, invoicedUnits: a.billableUnits, updatedAt: ctx.now })
      .where(eq(accruals.id, a.id));
    total += amount;
  }
  return total;
}

/** Overage not yet on an invoice, in base units. */
async function uninvoiced(ctx: CustomerCtx, subscriptionId: string): Promise<bigint> {
  const [r] = await ctx.tx
    .select({ v: sql<string>`coalesce(sum(${accruals.amount} - ${accruals.invoiced}), 0)::text` })
    .from(accruals)
    .where(eq(accruals.subscriptionId, subscriptionId));
  return BigInt(r!.v);
}

/** Write the renewal invoice at a period boundary, and an overage invoice when one is due. */
export async function writeInvoices(db: Db, settings: SettlementSettings, sub: SubRow, pv: PvRow, now: Date) {
  const periodMs = pv.periodHours! * HOUR_MS;
  await withCustomer(db, sub, async (ctx) => {
    const s = await reloadSub(ctx, sub.id);
    if (s.status === "ended" || s.status === "pending") return;
    const cur = periodAt(s.periodAnchor, pv.periodHours!, ctx.now);
    const open = await ctx.tx.select().from(invoices).where(and(eq(invoices.subscriptionId, s.id), eq(invoices.status, "open")));

    // Renewal: the first pull after a boundary starts the new on-chain period.
    const newPeriod = cur.start.getTime() > s.periodAnchor.getTime();
    const pastMargin = ctx.now.getTime() >= cur.start.getTime() + settings.boundaryMarginMs;
    const continuing = (s.cancelAt === null || s.cancelAt > cur.start) && (s.scheduledAt === null || s.scheduledAt > cur.start);
    if (newPeriod && pastMargin && continuing) {
      const [exists] = await ctx.tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.subscriptionId, s.id), eq(invoices.periodStart, cur.start), inArray(invoices.kind, ["activation", "renewal"])));
      if (!exists) {
        const invoiceId = newId("inv");
        await ctx.tx.insert(invoices).values({
          id: invoiceId,
          ...ctx.scope,
          customerId: s.customerId,
          subscriptionId: s.id,
          kind: "renewal",
          periodStart: cur.start,
          total: 0n,
        });
        let total = 0n;
        if (pv.baseAmount > 0n) {
          await ctx.tx.insert(invoiceLines).values({ id: newId("il"), invoiceId, kind: "base", amount: pv.baseAmount });
          total += pv.baseAmount;
        }
        // Unpaid invoices from the last period: their overage (with any write-off already applied)
        // moves onto this one. An unpaid base fee does not: a period that passed unpaid cannot be
        // charged later (doc 03, fact 7).
        for (const inv of open) {
          const lines = await ctx.tx
            .select()
            .from(invoiceLines)
            .where(and(eq(invoiceLines.invoiceId, inv.id), inArray(invoiceLines.kind, ["overage", "writeoff"])));
          for (const l of lines) {
            await ctx.tx.insert(invoiceLines).values({ ...l, id: newId("il"), invoiceId });
            total += l.amount;
          }
          await ctx.tx.update(invoices).set({ status: "void" }).where(eq(invoices.id, inv.id));
        }
        total += await addLinesFromAccruals(ctx, s.id, invoiceId);
        const paid = total === 0n;
        await ctx.tx
          .update(invoices)
          .set({ total, ...(paid ? { status: "paid" as const, paidAt: ctx.now } : {}) })
          .where(eq(invoices.id, invoiceId));
        await emit(ctx.tx, ctx.scope, "invoice.finalized", {
          invoiceId,
          subscriptionId: s.id,
          customerId: s.customerId,
          kind: "renewal",
          periodStart: cur.start.toISOString(),
          total: formatBaseUnits(total),
        });
        if (paid) await emit(ctx.tx, ctx.scope, "subscription.renewed", subPayload(s, { invoiceId, periodStart: cur.start.toISOString() }));
        return;
      }
    }

    // Overage, collected every `threshold`, and in full shortly before the period ends.
    if (open.length > 0) return;
    const due = await uninvoiced(ctx, s.id);
    if (due <= 0n) return;
    // A subscription replaced by a plan change collects what is owed at once: it grants nothing more.
    const closing = s.replacedBy !== null || ctx.now.getTime() >= cur.end.getTime() - settings.closeWindowMs(periodMs);
    if (due < settings.threshold && !closing) return;
    const invoiceId = newId("inv");
    await ctx.tx.insert(invoices).values({
      id: invoiceId,
      ...ctx.scope,
      customerId: s.customerId,
      subscriptionId: s.id,
      kind: "overage",
      periodStart: cur.start,
      total: 0n,
    });
    const total = await addLinesFromAccruals(ctx, s.id, invoiceId);
    await ctx.tx.update(invoices).set({ total }).where(eq(invoices.id, invoiceId));
    await emit(ctx.tx, ctx.scope, "invoice.finalized", {
      invoiceId,
      subscriptionId: s.id,
      customerId: s.customerId,
      kind: "overage",
      periodStart: cur.start.toISOString(),
      total: formatBaseUnits(total),
    });
  });
}

// ------------------------------------------------------------------ pulls

/** What the on-chain ceiling still allows in the period a pull sent now would land in. */
export function ceilingLeft(plan: OnchainPlan, onchain: OnchainSubscription, now: Date): { left: bigint; periodEnd: Date } {
  const len = onchain.periodHours * HOUR_MS;
  const p = periodAt(onchain.currentPeriodStart, onchain.periodHours, now);
  const rolled = p.start.getTime() !== onchain.currentPeriodStart.getTime();
  const pulled = rolled ? 0n : onchain.amountPulledInPeriod;
  const left = plan.amount - pulled;
  return { left: left > 0n ? left : 0n, periodEnd: new Date(p.start.getTime() + len) };
}

async function collect(
  db: Db,
  chain: Chain,
  settings: SettlementSettings,
  sub: SubRow,
  plan: OnchainPlan,
  onchain: OnchainSubscription,
  invoice: InvoiceRow,
  now: Date,
): Promise<boolean> {
  const due = invoice.total - invoice.amountPaid;
  const { left, periodEnd } = ceilingLeft(plan, onchain, now);
  let amount = due;

  if (left < due && invoice.kind === "topup") {
    // A refill is all or nothing: drop it rather than grant part of it.
    await withCustomer(db, sub, async (ctx) => {
      await ctx.tx
        .update(invoices)
        .set({ status: "void" })
        .where(and(eq(invoices.id, invoice.id), eq(invoices.status, "open")));
    });
    return false;
  }
  if (left < due) {
    // Cut to what the ceiling allows, write off the rest, and stop overage until the period ends (doc 03).
    const cut = due - left;
    amount = left;
    await withCustomer(db, sub, async (ctx) => {
      const [inv] = await ctx.tx.select().from(invoices).where(eq(invoices.id, invoice.id)).for("update");
      if (!inv || inv.status !== "open" || inv.total - inv.amountPaid !== due) return;
      await ctx.tx.insert(invoiceLines).values({ id: newId("il"), invoiceId: inv.id, kind: "writeoff", amount: -cut });
      const total = inv.total - cut;
      await ctx.tx
        .update(invoices)
        .set({ total, ...(total === inv.amountPaid ? { status: "paid" as const, paidAt: ctx.now } : {}) })
        .where(eq(invoices.id, inv.id));
      await ctx.tx.update(subscriptions).set({ overageBlockedUntil: periodEnd }).where(eq(subscriptions.id, sub.id));
    });
  }
  if (amount <= 0n) return false;

  const prepared = await chain.preparePull({ plan, subscriptionAddress: onchain.address, subscriber: sub.wallet!, amount });

  // Record the attempt before it is broadcast. The partial unique index on
  // (invoice_id) where pending refuses a second unresolved attempt.
  const attemptId = await withCustomer(db, sub, async (ctx) => {
    const [inv] = await ctx.tx.select().from(invoices).where(eq(invoices.id, invoice.id)).for("update");
    if (!inv || inv.status !== "open" || inv.total - inv.amountPaid !== amount) return null;
    const [inflight] = await ctx.tx
      .select({ id: settlementAttempts.id })
      .from(settlementAttempts)
      .where(and(eq(settlementAttempts.invoiceId, inv.id), eq(settlementAttempts.status, "pending")));
    if (inflight) return null;
    const [{ n }] = (await ctx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(settlementAttempts)
      .where(eq(settlementAttempts.invoiceId, inv.id))) as [{ n: number }];
    const id = newId("att");
    await ctx.tx.insert(settlementAttempts).values({
      id,
      ...ctx.scope,
      subscriptionId: sub.id,
      invoiceId: inv.id,
      attempt: n + 1,
      signature: prepared.signature,
      amount,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
    return id;
  });
  if (!attemptId) return false; // never sent, so it can never land

  const sent = await chain.send(prepared);
  if (!sent.ok && sent.definite) {
    await applyPullOutcome(db, chain, settings, attemptId, { state: "failed", error: sent.error });
    return true;
  }
  // If the send errored without a definite answer, it may still land: the outcome decides.
  const o = await waitForOutcome(chain, prepared.signature, prepared.lastValidBlockHeight, settings.confirmWaitMs, settings.pollMs);
  if (o.state !== "pending") await applyPullOutcome(db, chain, settings, attemptId, o);
  return true;
}

/** Apply the outcome of a pull. Only an attempt that is still pending changes, so this is safe to repeat. */
export async function applyPullOutcome(db: Db, chain: Chain, settings: SettlementSettings, attemptId: string, o: Outcome) {
  if (o.state === "pending") return;
  const [att] = await db.select().from(settlementAttempts).where(eq(settlementAttempts.id, attemptId));
  if (!att || att.status !== "pending") return;
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, att.subscriptionId!));

  // Which on-chain period the pull counted against; recorded for `verify`.
  const onchain = o.state === "confirmed" && sub!.subscriptionPda ? await chain.getSubscription(sub!.subscriptionPda) : null;

  await withCustomer(db, sub!, async (ctx) => {
    const [a] = await ctx.tx.select().from(settlementAttempts).where(eq(settlementAttempts.id, attemptId)).for("update");
    if (!a || a.status !== "pending") return;
    const s = await reloadSub(ctx, a.subscriptionId!);

    if (o.state === "expired") {
      await ctx.tx.update(settlementAttempts).set({ status: "expired", resolvedAt: ctx.now }).where(eq(settlementAttempts.id, a.id));
      return;
    }
    if (o.state === "confirmed") {
      await onPaid(ctx, a, s, onchain, o.finalized);
      return;
    }
    await ctx.tx
      .update(settlementAttempts)
      .set({ status: "failed", resolvedAt: ctx.now, errorKind: o.error.kind, errorCode: o.error.code, error: o.error.message })
      .where(eq(settlementAttempts.id, a.id));
    await onFailed(ctx, settings, a, s, o.error);
  });
}

async function onPaid(
  ctx: CustomerCtx,
  a: typeof settlementAttempts.$inferSelect,
  s: SubRow,
  onchain: OnchainSubscription | null,
  finalized: boolean,
) {
  await ctx.tx
    .update(settlementAttempts)
    .set({ status: "confirmed", resolvedAt: ctx.now, onchainPeriodStart: onchain?.currentPeriodStart ?? null })
    .where(eq(settlementAttempts.id, a.id));
  const [inv] = await ctx.tx.select().from(invoices).where(eq(invoices.id, a.invoiceId!)).for("update");
  await ctx.tx.insert(payments).values({
    id: newId("pay"),
    ...ctx.scope,
    customerId: s.customerId,
    subscriptionId: s.id,
    invoiceId: inv!.id,
    signature: a.signature,
    amount: a.amount,
    status: finalized ? "finalized" : "confirmed",
    finalizedAt: finalized ? ctx.now : null,
  });
  const amountPaid = inv!.amountPaid + a.amount;
  const paid = amountPaid >= inv!.total;
  await ctx.tx
    .update(invoices)
    // A voided invoice whose pull still landed keeps its status; the money is recorded against it.
    .set({ amountPaid, ...(paid && inv!.status === "open" ? { status: "paid" as const, paidAt: ctx.now } : {}) })
    .where(eq(invoices.id, inv!.id));
  if (paid) {
    const lines = await ctx.tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id));
    for (const l of lines) {
      if (l.kind === "overage" && l.accrualId) {
        await ctx.tx.update(accruals).set({ collected: sql`${accruals.collected} + ${l.amount}` }).where(eq(accruals.id, l.accrualId));
      }
      // An automatic top-up: the credits arrive once the money has.
      if (l.kind === "topup" && l.featureId && l.quantity) await grantTopUp(ctx, l.featureId, l.quantity);
    }
  }

  const recovered = s.status === "past_due";
  if (recovered) {
    await ctx.tx
      .update(subscriptions)
      .set({ status: s.cancelAt ? "canceling" : "active", pastDueSince: null, retryCount: 0, nextRetryAt: null })
      .where(eq(subscriptions.id, s.id));
  }
  await emit(ctx.tx, ctx.scope, "payment.succeeded", {
    invoiceId: inv!.id,
    subscriptionId: s.id,
    customerId: s.customerId,
    amount: formatBaseUnits(a.amount),
    signature: a.signature,
  });
  if (paid && inv!.kind === "renewal") {
    await emit(ctx.tx, ctx.scope, "subscription.renewed", subPayload(s, { invoiceId: inv!.id, periodStart: inv!.periodStart.toISOString(), recovered }));
  }
}

/** The failed-payment state machine (doc 03, "When a pull fails"). */
async function onFailed(ctx: CustomerCtx, settings: SettlementSettings, a: typeof settlementAttempts.$inferSelect, s: SubRow, error: ChainError) {
  switch (error.kind) {
    // Ours to fix, or a stale read: try again on the next pass with fresh chain state.
    case "transient":
    case "ceiling_reached":
      return;
    // The customer ended it on-chain, or the plan ended.
    case "subscription_cancelled":
    case "plan_expired":
    case "stale_authority":
    case "not_found":
      await endSubscription(ctx, s.id, error.kind === "subscription_cancelled" ? "canceled" : error.kind);
      return;
  }

  await emit(ctx.tx, ctx.scope, "payment.failed", {
    invoiceId: a.invoiceId,
    subscriptionId: s.id,
    customerId: s.customerId,
    amount: formatBaseUnits(a.amount),
    signature: a.signature,
    reason: error.kind,
    message: describeFailure(error),
  });

  const schedule = settings.retrySchedule;
  // A frozen account will not fix itself on a timer: no automatic retry, end at the grace period's end.
  const retries = error.kind !== "account_frozen";
  if (s.status !== "past_due") {
    const [u] = await ctx.tx
      .update(subscriptions)
      .set({
        status: "past_due",
        pastDueSince: ctx.now,
        retryCount: 0,
        nextRetryAt: retries ? new Date(ctx.now.getTime() + schedule[0]!) : null,
      })
      .where(eq(subscriptions.id, s.id))
      .returning();
    await emit(ctx.tx, ctx.scope, "subscription.past_due", subPayload(u!, { reason: error.kind, nextRetryAt: u!.nextRetryAt?.toISOString() ?? null }));
    return;
  }
  // A frozen account waits for the end of the grace period (checked in settleSubscription).
  if (!retries) {
    await ctx.tx.update(subscriptions).set({ nextRetryAt: null }).where(eq(subscriptions.id, s.id));
    return;
  }
  const retryCount = s.retryCount + 1;
  if (retryCount >= schedule.length) {
    await endSubscription(ctx, s.id, "payment_failed");
    return;
  }
  await ctx.tx
    .update(subscriptions)
    .set({ retryCount, nextRetryAt: new Date(s.pastDueSince!.getTime() + schedule[retryCount]!) })
    .where(eq(subscriptions.id, s.id));
}

// ------------------------------------------------------------------ finality

/**
 * `confirmed` counts as paid for entitlements; re-check at `finalized` (doc 03).
 * A payment whose transaction disappears (a dropped fork) is reverted and its
 * invoice reopened.
 */
export async function finalizePayments(db: Db, chain: Chain, env: Env, now: Date) {
  const rows = await db
    .select()
    .from(payments)
    .where(and(eq(payments.env, env), eq(payments.status, "confirmed"), sql`${payments.createdAt} < ${new Date(now.getTime() - 15_000)}`))
    .limit(200);
  if (rows.length === 0) return;
  const statuses = await chain.getStatuses(rows.map((r) => r.signature));
  for (const [i, p] of rows.entries()) {
    const st = statuses[i]!;
    if (st.state === "finalized") {
      await db.update(payments).set({ status: "finalized", finalizedAt: now }).where(eq(payments.id, p.id));
    } else if (st.state === "failed" || (st.state === "unknown" && now.getTime() - p.createdAt.getTime() > 10 * 60_000)) {
      await inCustomerTx(db, scopeOf(p), p.customerId, async (ctx) => {
        await ctx.tx.update(payments).set({ status: "reverted" }).where(eq(payments.id, p.id));
        await ctx.tx
          .update(invoices)
          .set({ amountPaid: sql`${invoices.amountPaid} - ${p.amount}`, status: "open", paidAt: null })
          .where(eq(invoices.id, p.invoiceId));
      }, { create: false });
    }
  }
}
