/**
 * The worker loop: settlement, reconciliation and webhook delivery on their
 * own cadences. Each job takes a Postgres advisory lock, so running two workers
 * is safe; the second one simply skips a job the first is running.
 */

import { sql } from "drizzle-orm";
import { clock, type Db } from "@usenummo/db";
import type { Chains } from "./chains.ts";
import { resolveSubmittedCheckouts } from "./checkout.ts";
import { reconcileAll } from "./reconcile.ts";
import type { SettlementSettings } from "./settings.ts";
import { settleAll } from "./settle.ts";
import { dispatchWebhooks } from "./webhooks.ts";

const LOCKS = { settle: 7_314_001, reconcile: 7_314_002, dispatch: 7_314_003 } as const;

/** Run `fn` only if no other worker holds the job's lock. Session-level lock on a dedicated connection. */
async function exclusive<T>(db: Db, job: keyof typeof LOCKS, fn: () => Promise<T>): Promise<T | null> {
  const pool = (db as unknown as { $client: import("pg").Pool }).$client;
  const conn = await pool.connect();
  try {
    const r = await conn.query("select pg_try_advisory_lock($1) as ok", [LOCKS[job]]);
    if (!r.rows[0].ok) return null;
    try {
      return await fn();
    } finally {
      await conn.query("select pg_advisory_unlock($1)", [LOCKS[job]]);
    }
  } finally {
    conn.release();
  }
}

/** One settlement pass: finish in-flight checkouts, then settle every live paid subscription. */
export async function settlementTick(db: Db, chains: Chains, settings: SettlementSettings) {
  return exclusive(db, "settle", async () => {
    const now = clock.now();
    await resolveSubmittedCheckouts(db, chains, now);
    return settleAll(db, chains, settings, now);
  });
}

export const reconcileTick = (db: Db, chains: Chains) => exclusive(db, "reconcile", () => reconcileAll(db, chains));
export const dispatchTick = (db: Db) => exclusive(db, "dispatch", () => dispatchWebhooks(db, { now: clock.now() }));

export type WorkerOptions = {
  settleEveryMs?: number;
  reconcileEveryMs?: number;
  dispatchEveryMs?: number;
  log?: (msg: string, data?: unknown) => void;
  signal?: AbortSignal;
};

/** Run until `signal` aborts. Each loop waits for its own previous run, so passes never overlap. */
export async function runWorker(db: Db, chains: Chains, settings: SettlementSettings, opts: WorkerOptions = {}) {
  const log = opts.log ?? ((m, d) => console.log(new Date().toISOString(), m, d === undefined ? "" : JSON.stringify(d)));
  const loop = async (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    while (!opts.signal?.aborted) {
      const started = Date.now();
      try {
        const r = await fn();
        if (r && typeof r === "object" && hasNews(r)) log(name, r);
      } catch (e) {
        log(`${name} failed`, { error: (e as Error).message });
      }
      const wait = Math.max(everyMs - (Date.now() - started), 250);
      await new Promise((res) => {
        const t = setTimeout(res, wait);
        opts.signal?.addEventListener("abort", () => (clearTimeout(t), res(null)), { once: true });
      });
    }
  };
  await Promise.all([
    loop("settle", opts.settleEveryMs ?? 10_000, () => settlementTick(db, chains, settings)),
    loop("reconcile", opts.reconcileEveryMs ?? 120_000, () => reconcileTick(db, chains)),
    loop("dispatch", opts.dispatchEveryMs ?? 2_000, () => dispatchTick(db)),
  ]);
}

/** Log a pass only when it did something. */
function hasNews(r: object): boolean {
  const o = r as Record<string, unknown>;
  return Object.entries(o).some(([k, v]) => (Array.isArray(v) ? v.length > 0 : typeof v === "number" && v > 0 && k !== "subscriptions" && k !== "checked"));
}
