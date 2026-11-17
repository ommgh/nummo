/**
 * Orgs and API keys. Keys are stored as SHA-256 hashes; test and live keys are
 * separate (doc 02, security basics).
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db, Env, Scope } from "./client.ts";
import { newId } from "./ids.ts";
import { apiKeys, orgs } from "./schema.ts";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function createOrg(db: Db, name: string): Promise<string> {
  const id = newId("org");
  await db.insert(orgs).values({ id, name });
  return id;
}

/** Create a secret key. The plain key is returned once and never stored. */
export async function createApiKey(db: Db, orgId: string, env: Env): Promise<{ id: string; key: string }> {
  const key = `bill_sk_${env}_${randomBytes(24).toString("base64url")}`;
  const id = newId("key");
  await db.insert(apiKeys).values({ id, orgId, env, keyHash: hashKey(key), prefix: key.slice(0, 18) });
  return { id, key };
}

export async function resolveApiKey(db: Db, key: string): Promise<Scope | null> {
  if (!key.startsWith("bill_sk_")) return null;
  const [row] = await db
    .select({ orgId: apiKeys.orgId, env: apiKeys.env })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)));
  return row ?? null;
}
