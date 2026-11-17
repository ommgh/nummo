/**
 * A small key-value store in Postgres, shared by every API instance. Agent
 * payments keep MPP replay markers here (packages/agents/src/store.ts).
 */

import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { kvStore } from "./schema.ts";

export type KvChange<R> = { op: "noop" | "set" | "delete"; value?: string; result: R };

export const kv = {
  async get(db: Db, key: string): Promise<string | null> {
    const [row] = await db.select({ value: kvStore.value }).from(kvStore).where(eq(kvStore.key, key));
    return row?.value ?? null;
  },
  async put(db: Db, key: string, value: string, expiresAt: Date | null = null) {
    await db.insert(kvStore).values({ key, value, expiresAt }).onConflictDoUpdate({ target: kvStore.key, set: { value, expiresAt } });
  },
  async delete(db: Db, key: string) {
    await db.delete(kvStore).where(eq(kvStore.key, key));
  },
  /** Atomic read-modify-write of one key; `fn` runs under a lock held for the key. */
  async update<R>(db: Db, key: string, fn: (current: string | null) => KvChange<R>, expiresAt: (value: string) => Date | null = () => null): Promise<R> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kv:${key}`}))`);
      const [row] = await tx.select({ value: kvStore.value }).from(kvStore).where(eq(kvStore.key, key));
      const change = fn(row?.value ?? null);
      if (change.op === "set") {
        const value = change.value!;
        await tx
          .insert(kvStore)
          .values({ key, value, expiresAt: expiresAt(value) })
          .onConflictDoUpdate({ target: kvStore.key, set: { value, expiresAt: expiresAt(value) } });
      } else if (change.op === "delete") {
        await tx.delete(kvStore).where(eq(kvStore.key, key));
      }
      return change.result;
    });
  },
  async sweep(db: Db, now = new Date()) {
    await db.delete(kvStore).where(lt(kvStore.expiresAt, now));
  },
};
