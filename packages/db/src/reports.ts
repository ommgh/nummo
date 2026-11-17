/**
 * Read-only figures for the merchant dashboard: subscribers, revenue
 * collected, usage, payments, webhook delivery. Everything is scoped to one
 * org and environment, and money stays in base units until formatted.
 */

import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { formatBaseUnits, formatQty, qty } from "@usenummo/core";
import type { Db, Scope } from "./client.ts";
import { customers, invoices, outbox, payments, planVersions, subscriptions, usageEvents, webhookEndpoints } from "./schema.ts";

const DAY = 86_400_000;
// Every table here has org_id and env columns.
const inScope = (t: any, scope: Scope) => and(eq(t.orgId, scope.orgId), eq(t.env, scope.env));

export async function overview(db: Db, scope: Scope, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const [[c], live, [collected], daily, usage, [webhooks], recent] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(customers).where(inScope(customers, scope)),
    db
      .select({ status: subscriptions.status, base: planVersions.baseAmount, hours: planVersions.periodHours })
      .from(subscriptions)
      .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
      .where(
        and(
          inScope(subscriptions, scope),
          inArray(subscriptions.status, ["active", "past_due", "canceling"]),
          isNull(subscriptions.replacedBy),
          sql`${planVersions.ceilingAmount} is not null`,
        ),
      ),
    db
      .select({ v: sql<string>`coalesce(sum(${payments.amount}), 0)::text`, n: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(inScope(payments, scope), sql`${payments.status} <> 'reverted'`, gt(payments.createdAt, since))),
    db
      .select({ day: sql<string>`to_char(date_trunc('day', ${payments.createdAt}), 'YYYY-MM-DD')`, v: sql<string>`sum(${payments.amount})::text` })
      .from(payments)
      .where(and(inScope(payments, scope), sql`${payments.status} <> 'reverted'`, gt(payments.createdAt, since)))
      .groupBy(sql`1`),
    db
      .select({ featureId: usageEvents.featureId, total: sql<string>`sum(${usageEvents.value})::text`, events: sql<number>`count(*)::int` })
      .from(usageEvents)
      .where(and(inScope(usageEvents, scope), gt(usageEvents.occurredAt, since)))
      .groupBy(usageEvents.featureId)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        pending: sql<number>`count(*) filter (where ${outbox.deliveredAt} is null and ${outbox.deadAt} is null)::int`,
        failing: sql<number>`count(*) filter (where ${outbox.deliveredAt} is null and ${outbox.attempts} > 0 and ${outbox.deadAt} is null)::int`,
        dead: sql<number>`count(*) filter (where ${outbox.deadAt} is not null)::int`,
      })
      .from(outbox)
      .where(and(inScope(outbox, scope), gt(outbox.createdAt, since))),
    listPayments(db, scope, { limit: 8 }),
  ]);

  // A 30-day run rate: each live paid plan's base fee scaled to 720 hours. Periods are hours, not months.
  const runRate = live.reduce((s, l) => s + (l.hours ? (l.base * 720n) / BigInt(l.hours) : 0n), 0n);
  const days: { day: string; amount: string }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10);
    const hit = daily.find((x) => x.day === d);
    days.push({ day: d, amount: formatBaseUnits(BigInt(hit?.v ?? "0")) });
  }
  return {
    customers: c!.n,
    paidSubscribers: live.length,
    pastDue: live.filter((l) => l.status === "past_due").length,
    canceling: live.filter((l) => l.status === "canceling").length,
    runRate30d: formatBaseUnits(runRate),
    collected30d: formatBaseUnits(BigInt(collected!.v)),
    payments30d: collected!.n,
    daily: days,
    usage: usage.map((u) => ({ featureId: u.featureId, total: formatQty(qty(u.total)), events: u.events })),
    webhooks: webhooks!,
    webhookEndpoint: (await db.select({ url: webhookEndpoints.url }).from(webhookEndpoints).where(and(inScope(webhookEndpoints, scope), isNull(webhookEndpoints.disabledAt))))[0]?.url ?? null,
    recentPayments: recent,
  };
}

export async function listPayments(db: Db, scope: Scope, q: { limit?: number; customerId?: string } = {}) {
  const rows = await db
    .select({ p: payments, kind: invoices.kind })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(and(inScope(payments, scope), q.customerId ? eq(payments.customerId, q.customerId) : undefined))
    .orderBy(desc(payments.createdAt))
    .limit(Math.min(q.limit ?? 100, 500));
  return rows.map(({ p, kind }) => ({
    id: p.id,
    customerId: p.customerId,
    subscriptionId: p.subscriptionId,
    invoiceId: p.invoiceId,
    kind,
    amount: formatBaseUnits(p.amount),
    signature: p.signature,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
  }));
}

export async function webhookStatus(db: Db, scope: Scope) {
  const [endpoint] = await db.select().from(webhookEndpoints).where(and(inScope(webhookEndpoints, scope), isNull(webhookEndpoints.disabledAt)));
  const events = await db.select().from(outbox).where(inScope(outbox, scope)).orderBy(desc(outbox.id)).limit(50);
  return {
    endpoint: endpoint ? { url: endpoint.url, createdAt: endpoint.createdAt.toISOString() } : null,
    events: events.map((e) => ({
      id: e.id.toString(),
      type: e.eventType,
      createdAt: e.createdAt.toISOString(),
      state: e.deliveredAt ? "delivered" : e.deadAt ? "dead" : e.attempts > 0 ? "retrying" : "pending",
      attempts: e.attempts,
      lastError: e.lastError,
      payload: e.payload,
    })),
  };
}

/**
 * Usage per day for the busiest features (by event count) over the last `days`
 * days, zero-filled, for the dashboard's usage chart. Values are decimal strings.
 */
export async function usageDaily(db: Db, scope: Scope, q: { days?: number; features?: number } = {}, now = new Date()) {
  const days = Math.min(Math.max(q.days ?? 30, 1), 90);
  const since = new Date(now.getTime() - days * DAY);
  const top = await db
    .select({ featureId: usageEvents.featureId })
    .from(usageEvents)
    .where(and(inScope(usageEvents, scope), gt(usageEvents.occurredAt, since)))
    .groupBy(usageEvents.featureId)
    .orderBy(desc(sql`count(*)`))
    .limit(Math.min(Math.max(q.features ?? 3, 1), 8));
  const features = top.map((t) => t.featureId);
  const rows = features.length
    ? await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${usageEvents.occurredAt}), 'YYYY-MM-DD')`,
          featureId: usageEvents.featureId,
          total: sql<string>`sum(${usageEvents.value})::text`,
        })
        .from(usageEvents)
        .where(and(inScope(usageEvents, scope), gt(usageEvents.occurredAt, since), inArray(usageEvents.featureId, features)))
        .groupBy(sql`1`, usageEvents.featureId)
    : [];
  const series: { day: string; values: Record<string, string> }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * DAY).toISOString().slice(0, 10);
    const values: Record<string, string> = {};
    for (const f of features) {
      const hit = rows.find((r) => r.day === day && r.featureId === f);
      values[f] = hit ? formatQty(qty(hit.total)) : "0";
    }
    series.push({ day, values });
  }
  return { features, series };
}
