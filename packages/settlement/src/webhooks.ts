/**
 * Webhook outbox and dispatcher (doc 02, "Webhooks to the merchant").
 *
 * Events are written to `outbox` in the same transaction as the change they
 * describe. The dispatcher leases a batch, POSTs each event to the merchant's
 * endpoint with an HMAC signature, and retries failures with backoff.
 *
 * Signature header, in the style of Stripe's:
 *   X-Nummo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 * Signing the timestamp lets receivers reject replays.
 */

import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { type Db, newId, NummoError, schema, type Scope } from "@usenummo/db";

const { outbox, webhookEndpoints } = schema;

export const SIGNATURE_HEADER = "X-Nummo-Signature";
const MAX_ATTEMPTS = 12;
const LEASE_MS = 60_000;

export function signPayload(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Backoff after the n-th failed delivery: 10s, 20s, 40s ... capped at 6 hours. */
export function backoffMs(attempts: number): number {
  return Math.min(10_000 * 2 ** Math.max(attempts - 1, 0), 6 * 3_600_000);
}

export async function setWebhookEndpoint(db: Db, scope: Scope, url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NummoError("invalid_request", "url must be an absolute URL");
  }
  if (scope.env === "live" && parsed.protocol !== "https:") throw new NummoError("invalid_request", "live webhook endpoints must use https");
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const id = newId("whe");
  await db.transaction(async (tx) => {
    await tx
      .update(webhookEndpoints)
      .set({ disabledAt: new Date() })
      .where(and(eq(webhookEndpoints.orgId, scope.orgId), eq(webhookEndpoints.env, scope.env), isNull(webhookEndpoints.disabledAt)));
    await tx.insert(webhookEndpoints).values({ id, ...scope, url: parsed.toString(), secret });
  });
  // The secret is shown here and on GET, so the merchant can configure their receiver.
  return { id, url: parsed.toString(), secret };
}

export async function getWebhookEndpoint(db: Db, scope: Scope) {
  const [e] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.orgId, scope.orgId), eq(webhookEndpoints.env, scope.env), isNull(webhookEndpoints.disabledAt)));
  return e ? { id: e.id, url: e.url, secret: e.secret, createdAt: e.createdAt.toISOString() } : null;
}

export async function deleteWebhookEndpoint(db: Db, scope: Scope) {
  await db
    .update(webhookEndpoints)
    .set({ disabledAt: new Date() })
    .where(and(eq(webhookEndpoints.orgId, scope.orgId), eq(webhookEndpoints.env, scope.env), isNull(webhookEndpoints.disabledAt)));
}

export type DispatchReport = { delivered: number; failed: number; dead: number };

/**
 * Deliver due events. Only events created after the endpoint was registered are
 * sent, so registering an endpoint does not replay history.
 */
export async function dispatchWebhooks(
  db: Db,
  opts: { now?: Date; fetch?: typeof fetch; timeoutMs?: number; batch?: number } = {},
): Promise<DispatchReport> {
  const now = opts.now ?? new Date();
  const doFetch = opts.fetch ?? fetch;
  const report: DispatchReport = { delivered: 0, failed: 0, dead: 0 };

  // Lease a batch: push next_attempt_at forward so a second dispatcher skips these rows.
  const leased = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ e: outbox, ep: webhookEndpoints })
      .from(outbox)
      .innerJoin(
        webhookEndpoints,
        and(eq(webhookEndpoints.orgId, outbox.orgId), eq(webhookEndpoints.env, outbox.env), isNull(webhookEndpoints.disabledAt)),
      )
      .where(
        and(
          isNull(outbox.deliveredAt),
          isNull(outbox.deadAt),
          lte(outbox.nextAttemptAt, now),
          sql`${outbox.createdAt} >= ${webhookEndpoints.createdAt}`,
        ),
      )
      .orderBy(asc(outbox.id))
      .limit(opts.batch ?? 100)
      .for("update", { of: outbox, skipLocked: true });
    if (rows.length) {
      await tx
        .update(outbox)
        .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
        .where(inArray(outbox.id, rows.map((r) => r.e.id)));
    }
    return rows;
  });

  for (const { e, ep } of leased) {
    const body = JSON.stringify({ id: `evt_${e.id}`, type: e.eventType, env: e.env, createdAt: e.createdAt.toISOString(), data: e.payload });
    const t = Math.floor(Date.now() / 1000);
    let error: string | null = null;
    try {
      const res = await doFetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signPayload(ep.secret, body, t), "user-agent": "nummo-webhooks/0" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) error = `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      error = (err as Error).message;
    }

    if (!error) {
      await db.update(outbox).set({ deliveredAt: new Date(), attempts: e.attempts + 1, lastError: null }).where(eq(outbox.id, e.id));
      report.delivered++;
      continue;
    }
    const attempts = e.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.update(outbox).set({ attempts, lastError: error, deadAt: new Date() }).where(eq(outbox.id, e.id));
      report.dead++;
    } else {
      await db
        .update(outbox)
        .set({ attempts, lastError: error, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)) })
        .where(eq(outbox.id, e.id));
      report.failed++;
    }
  }
  return report;
}
