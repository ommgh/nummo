/**
 * Reconciliation by polling (doc 03, "Reconciliation"). Customers can act
 * on-chain without us: cancel from another interface, close their authority,
 * or revoke the record. Polling the records is the source of truth for the
 * first version; program events are a later optimisation.
 *
 * `reconcileAll` corrects our records. `verify` only reports differences, for
 * `GET /v1/verify` and `nummo verify`.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { formatBaseUnits, HOUR_MS } from "@usenummo/core";
import { type Db, type Env, schema, type Scope } from "@usenummo/db";
import type { Chain } from "@usenummo/solana";
import type { Chains } from "./chains.ts";
import { applyOnchainState, settleableSubscriptions } from "./settle.ts";

const { planVersions, settlementAttempts, subscriptions } = schema;

export type ReconcileReport = { checked: number; changed: number; errors: { subscriptionId: string; error: string }[] };

export async function reconcileAll(db: Db, chains: Chains): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, changed: 0, errors: [] };
  for (const env of ["test", "live"] as const) {
    const chain = chains[env];
    if (!chain) continue;
    for (const { sub } of await settleableSubscriptions(db, env)) {
      report.checked++;
      try {
        const onchain = await chain.getSubscription(sub.subscriptionPda!);
        const authority = onchain ? await chain.getAuthority(sub.wallet!) : null;
        const after = await applyOnchainState(db, sub, onchain, authority);
        if (!after || after.status !== sub.status || after.cancelAt?.getTime() !== sub.cancelAt?.getTime()) report.changed++;
      } catch (e) {
        report.errors.push({ subscriptionId: sub.id, error: (e as Error).message });
      }
    }
  }
  return report;
}

export type Difference = {
  /** `drift` means our records and the chain disagree. `notice` is worth knowing but expected. */
  severity: "drift" | "notice";
  kind: string;
  subject: string;
  message: string;
};

export type VerifyReport = {
  env: Env;
  network: string;
  checkedAt: string;
  plans: number;
  subscriptions: number;
  ok: boolean;
  differences: Difference[];
};

/** Compare our records with the chain, like Autumn's verify does for Stripe. Read-only. */
export async function verify(db: Db, chain: Chain, scope: Scope, now = new Date()): Promise<VerifyReport> {
  const diffs: Difference[] = [];
  const add = (severity: Difference["severity"], kind: string, subject: string, message: string) => diffs.push({ severity, kind, subject, message });

  // Plans
  const versions = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.orgId, scope.orgId), eq(planVersions.env, scope.env), isNotNull(planVersions.ceilingAmount)));
  for (const pv of versions) {
    const subject = `plan ${pv.planId}@${pv.version}`;
    if (!pv.onchainPlanPda) {
      add("notice", "plan_unpublished", subject, "paid plan version has no on-chain plan yet; run `nummo plans publish`");
      continue;
    }
    const p = await chain.getPlan(pv.onchainPlanPda);
    if (!p) {
      add("drift", "plan_missing", subject, `on-chain plan ${pv.onchainPlanPda} does not exist`);
      continue;
    }
    if (p.amount !== pv.ceilingAmount) add("drift", "plan_amount", subject, `ceiling is ${formatBaseUnits(pv.ceilingAmount!)} here, ${formatBaseUnits(p.amount)} on-chain`);
    if (p.periodHours !== pv.periodHours) add("drift", "plan_period", subject, `period is ${pv.periodHours}h here, ${p.periodHours}h on-chain`);
    if (p.mint !== chain.mint) add("drift", "plan_mint", subject, `on-chain plan charges ${p.mint}, this deployment settles in ${chain.mint}`);
    if (p.owner !== chain.pullerAddress && !p.pullers.includes(chain.pullerAddress)) {
      add("drift", "puller_not_listed", subject, `the puller ${chain.pullerAddress} is not on the plan's puller list, so pulls will fail`);
    }
    if (p.status === "sunset") add("notice", "plan_sunset", subject, "the on-chain plan is sunset; existing subscribers can still be charged");
    if (p.endTs !== 0n && BigInt(Math.floor(now.getTime() / 1000)) > p.endTs) add("drift", "plan_ended", subject, "the on-chain plan has passed its end time");
  }

  // Live paid subscriptions
  const subs = await db
    .select({ sub: subscriptions, pv: planVersions })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .where(
      and(
        eq(subscriptions.orgId, scope.orgId),
        eq(subscriptions.env, scope.env),
        inArray(subscriptions.status, ["active", "past_due", "canceling"]),
        isNotNull(subscriptions.subscriptionPda),
      ),
    );
  for (const { sub, pv } of subs) {
    const subject = `subscription ${sub.id} (customer ${sub.customerId})`;
    const s = await chain.getSubscription(sub.subscriptionPda!);
    if (!s) {
      add("drift", "subscription_missing", subject, `on-chain record ${sub.subscriptionPda} is gone (revoked); we still have it ${sub.status}`);
      continue;
    }
    const auth = await chain.getAuthority(sub.wallet!);
    if (!auth || auth.initId !== s.initId) add("drift", "authority_closed", subject, "the wallet's subscription authority was closed or re-created; pulls will fail");
    if (s.subscriber !== sub.wallet) add("drift", "wallet", subject, `wallet is ${sub.wallet} here, ${s.subscriber} on-chain`);
    if (s.amount !== pv.ceilingAmount || s.periodHours !== pv.periodHours) add("drift", "terms", subject, "the signed terms differ from the plan version");

    const ourCancel = sub.cancelAt?.getTime() ?? null;
    const theirCancel = s.expiresAt?.getTime() ?? null;
    if (ourCancel !== theirCancel) {
      add(
        "drift",
        "cancellation",
        subject,
        `cancellation is ${sub.cancelAt?.toISOString() ?? "none"} here, ${s.expiresAt?.toISOString() ?? "none"} on-chain`,
      );
    }

    const len = s.periodHours * HOUR_MS;
    const offset = s.currentPeriodStart.getTime() - sub.periodAnchor.getTime();
    if (offset < 0 || offset % len !== 0) {
      add("drift", "period_anchor", subject, `our periods start from ${sub.periodAnchor.toISOString()}, the chain's current period from ${s.currentPeriodStart.toISOString()}`);
    }

    // What we collected in the chain's current period must equal what the chain counted.
    const [ours] = await db
      .select({ v: sql<string>`coalesce(sum(${settlementAttempts.amount}), 0)::text` })
      .from(settlementAttempts)
      .where(
        and(
          eq(settlementAttempts.subscriptionId, sub.id),
          eq(settlementAttempts.status, "confirmed"),
          eq(settlementAttempts.onchainPeriodStart, s.currentPeriodStart),
        ),
      );
    const collected = BigInt(ours!.v);
    if (collected !== s.amountPulledInPeriod) {
      add(
        "drift",
        "amount_pulled",
        subject,
        `we recorded ${formatBaseUnits(collected)} collected in the period from ${s.currentPeriodStart.toISOString()}, the chain counts ${formatBaseUnits(s.amountPulledInPeriod)}`,
      );
    }

    const [inflight] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(settlementAttempts)
      .where(and(eq(settlementAttempts.subscriptionId, sub.id), eq(settlementAttempts.status, "pending")));
    if (inflight!.n > 0) add("notice", "in_flight", subject, `${inflight!.n} transaction(s) awaiting confirmation`);
  }

  // Ended here but still open on-chain: we stop pulling; the customer may revoke it (doc 03, plan changes).
  const ended = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.orgId, scope.orgId),
        eq(subscriptions.env, scope.env),
        eq(subscriptions.status, "ended"),
        isNotNull(subscriptions.subscriptionPda),
        sql`${subscriptions.endedAt} > ${new Date(now.getTime() - 30 * 24 * HOUR_MS)}`,
      ),
    );
  for (const sub of ended) {
    const s = await chain.getSubscription(sub.subscriptionPda!);
    if (s && (s.expiresAt === null || s.expiresAt > now)) {
      add("notice", "onchain_still_open", `subscription ${sub.id} (customer ${sub.customerId})`, `ended here (${sub.endedReason}); the on-chain record is still open and will not be pulled`);
    }
  }

  return {
    env: scope.env,
    network: chain.network,
    checkedAt: now.toISOString(),
    plans: versions.length,
    subscriptions: subs.length,
    ok: !diffs.some((d) => d.severity === "drift"),
    differences: diffs,
  };
}
