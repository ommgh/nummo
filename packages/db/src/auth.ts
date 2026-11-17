/**
 * Orgs and API keys. Keys are stored as SHA-256 hashes; test and live keys are
 * separate (doc 02, security basics).
 */

import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db, Env, Scope } from "./client.ts";
import { newId } from "./ids.ts";
import { apiKeys, authMembers, authOrganizations, authUsers, orgs } from "./schema.ts";

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

/** Keys of one org and environment, newest first, for the dashboard. Hashes never leave the database. */
export async function listApiKeys(db: Db, orgId: string) {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId)).orderBy(desc(apiKeys.createdAt));
  return rows.map((k) => ({
    id: k.id,
    env: k.env,
    prefix: k.prefix,
    createdAt: k.createdAt.toISOString(),
    revokedAt: k.revokedAt?.toISOString() ?? null,
  }));
}

export async function revokeApiKey(db: Db, orgId: string, id: string): Promise<boolean> {
  const r = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return r.length > 0;
}

/** The nummo org behind a Better Auth organization: created with the same id, if missing. */
export async function ensureOrg(db: Db, id: string, name: string) {
  await db.insert(orgs).values({ id, name }).onConflictDoNothing();
}

// ------------------------------------------------------------------ dashboard accounts (Better Auth tables)

/** A user's role in an organization, or null when they are not a member. */
export async function memberRole(db: Db, userId: string, organizationId: string): Promise<string | null> {
  const [m] = await db
    .select({ role: authMembers.role })
    .from(authMembers)
    .where(and(eq(authMembers.userId, userId), eq(authMembers.organizationId, organizationId)));
  return m?.role ?? null;
}

/** The organization a user joined first: where a new session starts. */
export async function firstOrganization(db: Db, userId: string): Promise<string | null> {
  const [m] = await db
    .select({ organizationId: authMembers.organizationId })
    .from(authMembers)
    .where(eq(authMembers.userId, userId))
    .orderBy(asc(authMembers.createdAt))
    .limit(1);
  return m?.organizationId ?? null;
}

export async function getOrganization(db: Db, id: string) {
  const [o] = await db.select().from(authOrganizations).where(eq(authOrganizations.id, id));
  return o ? { id: o.id, name: o.name, slug: o.slug } : null;
}

export async function renameOrg(db: Db, id: string, name: string) {
  await db.update(orgs).set({ name }).where(eq(orgs.id, id));
}

/**
 * Give an existing nummo org (one made by bootstrap) a dashboard organization
 * and make a signed-up user its owner. Idempotent.
 */
export async function addOrgOwner(db: Db, orgId: string, email: string): Promise<{ userId: string } | null> {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) throw new Error(`no org ${orgId}`);
  const [user] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email.toLowerCase()));
  if (!user) return null;
  const slug = `${org.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org"}-${orgId.slice(-6).toLowerCase()}`;
  await db.insert(authOrganizations).values({ id: orgId, name: org.name, slug, createdAt: new Date() }).onConflictDoNothing();
  if (!(await memberRole(db, user.id, orgId))) {
    await db.insert(authMembers).values({ id: newId("mem"), organizationId: orgId, userId: user.id, role: "owner", createdAt: new Date() });
  }
  return { userId: user.id };
}
