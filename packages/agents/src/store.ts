/**
 * The MPP replay store in Postgres, so a payment credential is accepted once
 * across every API instance (Solana MPP docs, "Production verification": the
 * replay check and consume must be atomic across all server instances).
 *
 * mppx's string-valued adapter (`Store.cloudflare`) handles encoding; we supply
 * get, put, delete and an atomic update serialised per key (`kv` in @usenummo/db).
 */

import { Store } from "@solana/pay-kit";
import { type Db, kv } from "@usenummo/db";

/** A replay marker's expiry, when the value carries one, so old rows can be removed. */
function expiryOf(value: string): Date | null {
  try {
    const v = JSON.parse(value) as { expires?: unknown };
    return typeof v?.expires === "number" ? new Date(v.expires) : null;
  } catch {
    return null;
  }
}

type Adapter = Parameters<typeof Store.cloudflare>[0];

export function pgStore(db: Db) {
  let writes = 0;
  const sweep = async () => {
    if (++writes % 100 === 0) await kv.sweep(db);
  };
  const adapter = {
    get: (key: string) => kv.get(db, key),
    put: async (key: string, value: string) => {
      await kv.put(db, key, value, expiryOf(value));
      await sweep();
    },
    delete: (key: string) => kv.delete(db, key),
    update: async (key: string, fn: Parameters<typeof kv.update>[2]) => {
      const r = await kv.update(db, key, fn, expiryOf);
      await sweep();
      return r;
    },
  };
  return Store.cloudflare(adapter as Adapter & { update: NonNullable<Adapter["update"]> });
}
