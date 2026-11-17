/**
 * Orgs and API keys. Keys are stored as SHA-256 hashes; test and live keys are
 * separate (doc 02, security basics).
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db, Env, Scope } from "./client.ts";
import { newId } from "./ids.ts";
import { apiKeys, dashboardSessions, orgs } from "./schema.ts";

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
  const key = `nummo_sk_${env}_${randomBytes(24).toString("base64url")}`;
  const id = newId("key");
  await db.insert(apiKeys).values({ id, orgId, env, keyHash: hashKey(key), prefix: key.slice(0, 18) });
  return { id, key };
}

export async function resolveApiKey(db: Db, key: string): Promise<Scope | null> {
  if (!key.startsWith("nummo_sk_")) return null;
  const [row] = await db
    .select({ orgId: apiKeys.orgId, env: apiKeys.env })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)));
  return row ?? null;
}

export async function resolveApiKeyRow(db: Db, key: string) {
  if (!key.startsWith("nummo_sk_")) return null;
  const [row] = await db
    .select({ id: apiKeys.id, orgId: apiKeys.orgId, env: apiKeys.env, org: orgs.name })
    .from(apiKeys)
    .innerJoin(orgs, eq(orgs.id, apiKeys.orgId))
    .where(and(eq(apiKeys.keyHash, hashKey(key)), isNull(apiKeys.revokedAt)));
  return row ?? null;
}

/** How long a dashboard sign-in lasts. */
export const DASHBOARD_SESSION_MS = 12 * 3_600_000;

/**
 * Sign in to the dashboard with a secret key. The cookie gets a random token,
 * never the key; we store the token's hash and which key it came from, so
 * revoking the key ends the session too.
 */
export async function createDashboardSession(db: Db, key: string): Promise<{ token: string; expiresAt: Date } | null> {
  const row = await resolveApiKeyRow(db, key.trim());
  if (!row) return null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + DASHBOARD_SESSION_MS);
  await db.insert(dashboardSessions).values({ tokenHash: hashKey(token), orgId: row.orgId, env: row.env, apiKeyId: row.id, expiresAt });
  return { token, expiresAt };
}

export async function resolveDashboardSession(db: Db, token: string): Promise<(Scope & { org: string }) | null> {
  const [row] = await db
    .select({ orgId: dashboardSessions.orgId, env: dashboardSessions.env, org: orgs.name })
    .from(dashboardSessions)
    .innerJoin(apiKeys, eq(apiKeys.id, dashboardSessions.apiKeyId))
    .innerJoin(orgs, eq(orgs.id, dashboardSessions.orgId))
    .where(and(eq(dashboardSessions.tokenHash, hashKey(token)), gt(dashboardSessions.expiresAt, new Date()), isNull(apiKeys.revokedAt)));
  return row ?? null;
}

export async function endDashboardSession(db: Db, token: string) {
  await db.delete(dashboardSessions).where(eq(dashboardSessions.tokenHash, hashKey(token)));
}
