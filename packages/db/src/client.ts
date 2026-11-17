import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export type Env = "test" | "live";
/** The merchant and environment every query is scoped to. */
export type Scope = { orgId: string; env: Env };

export function createDb(url: string = process.env.DATABASE_URL ?? "postgres://bill:bill@localhost:5434/bill") {
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 20) });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
