import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export type Env = "test" | "live";
/** The merchant and environment every query is scoped to. */
export type Scope = { orgId: string; env: Env };

export function createDb(url: string = process.env.DATABASE_URL ?? "postgres://nummo:nummo@localhost:5434/nummo") {
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 20) });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/**
 * Create the database named in `url` if it does not exist. The test suite and
 * the devnet scenarios use their own databases so their rows never mix with
 * development data (a worker settles every org in an environment).
 */
export async function ensureDatabase(url: string) {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`refusing to create database with name ${JSON.stringify(name)}`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const r = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (r.rowCount === 0) await client.query(`create database ${name}`);
  } finally {
    await client.end();
  }
}
