/**
 * Applying the pricing config (PUT /v1/config) and loading it for the hot path.
 */

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { type ConfigDoc, ConfigError, onchainTerms, type PlanDoc, validateDocument } from "@usenummo/config";
import { type Catalog, type FeatureDef, qty } from "@usenummo/core";
import type { Db, DbOrTx, Scope } from "./client.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import { creditRates, envSettings, features, planItems, plans, planVersions } from "./schema.ts";

export type ConfigChange = { kind: "feature" | "plan_version" | "settings"; id: string; action: "create" | "update" | "unchanged" | "archive" };

/**
 * The fields an on-chain plan freezes. Changing any of them needs a new version
 * (doc 04 rules), because the customer signed these terms.
 */
function frozenTerms(p: PlanDoc) {
  return canonical({
    price: p.price,
    ceiling: onchainTerms(p)?.amount.toString() ?? null,
    overage: p.items
      .filter((i) => i.overage)
      .map((i) => [i.feature, i.overage])
      .sort(),
    // Absent from documents written before top-ups existed: compare those as "none".
    autoTopUp: p.items
      .filter((i) => i.autoTopUp)
      .map((i) => [i.feature, i.autoTopUp])
      .sort(),
  });
}

/** JSON with sorted keys: jsonb does not keep key order, so plain stringify cannot compare. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Apply a config document. With `dryRun`, compute the diff and roll back. */
export async function applyConfig(db: Db, scope: Scope, raw: unknown, opts: { dryRun?: boolean } = {}) {
  let doc: ConfigDoc;
  try {
    doc = validateDocument(raw);
  } catch (e) {
    if (e instanceof ConfigError) throw new NummoError("invalid_config", e.message, { issues: e.issues });
    throw e;
  }

  const changes: ConfigChange[] = [];
  const DRY = Symbol("dry run");
  try {
    await db.transaction(async (tx) => {
      // Serialise concurrent pushes for the same org and environment.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`config:${scope.orgId}:${scope.env}`}))`);

      // Features
      const existing = await tx.select().from(features).where(and(eq(features.orgId, scope.orgId), eq(features.env, scope.env)));
      const byId = new Map(existing.map((f) => [f.id, f]));
      for (const f of doc.features) {
        const prev = byId.get(f.id);
        const row = { ...scope, id: f.id, name: f.name ?? null, type: f.type, consumable: f.type === "metered" ? f.consumable : true };
        if (!prev) {
          await tx.insert(features).values(row);
          changes.push({ kind: "feature", id: f.id, action: "create" });
        } else {
          if (prev.type !== f.type) {
            throw new NummoError("invalid_config", `feature ${f.id} cannot change type from ${prev.type} to ${f.type}; use a new id`);
          }
          const same = prev.name === row.name && prev.consumable === row.consumable && prev.archivedAt === null;
          await tx
            .update(features)
            .set({ name: row.name, consumable: row.consumable, archivedAt: null, updatedAt: new Date() })
            .where(and(eq(features.orgId, scope.orgId), eq(features.env, scope.env), eq(features.id, f.id)));
          changes.push({ kind: "feature", id: f.id, action: same ? "unchanged" : "update" });
        }
      }
      const keep = doc.features.map((f) => f.id);
      const archived = await tx
        .update(features)
        .set({ archivedAt: new Date() })
        .where(
          and(
            eq(features.orgId, scope.orgId),
            eq(features.env, scope.env),
            isNull(features.archivedAt),
            keep.length ? notInArray(features.id, keep) : sql`true`,
          ),
        )
        .returning({ id: features.id });
      for (const a of archived) changes.push({ kind: "feature", id: a.id, action: "archive" });

      // Credit rates: replaced wholesale.
      await tx.delete(creditRates).where(and(eq(creditRates.orgId, scope.orgId), eq(creditRates.env, scope.env)));
      const rates = doc.features.flatMap((f) =>
        f.type === "credit_system"
          ? f.rates.map((r) => ({ ...scope, creditFeatureId: f.id, meteredFeatureId: r.feature, creditsPerUnit: r.credits }))
          : [],
      );
      if (rates.length) await tx.insert(creditRates).values(rates);

      // Plans and versions
      await tx
        .update(planVersions)
        .set({ isDefault: false })
        .where(and(eq(planVersions.orgId, scope.orgId), eq(planVersions.env, scope.env)));

      for (const p of doc.plans) {
        await tx
          .insert(plans)
          .values({ ...scope, id: p.id, name: p.name, isAddon: p.isAddon })
          .onConflictDoUpdate({
            target: [plans.orgId, plans.env, plans.id],
            set: { name: p.name, isAddon: p.isAddon, updatedAt: new Date() },
          });

        const [prev] = await tx
          .select()
          .from(planVersions)
          .where(
            and(
              eq(planVersions.orgId, scope.orgId),
              eq(planVersions.env, scope.env),
              eq(planVersions.planId, p.id),
              eq(planVersions.version, p.version),
            ),
          );
        const terms = onchainTerms(p);
        const versionRow = {
          name: p.name,
          isDefault: p.default,
          baseAmount: BigInt(p.price?.amount ?? 0),
          periodHours: p.price?.periodHours ?? null,
          ceilingAmount: terms?.amount ?? null,
          document: p,
        };

        let versionId: string;
        if (prev) {
          if (frozenTerms(prev.document as PlanDoc) !== frozenTerms(p)) {
            throw new NummoError(
              "version_required",
              `plan ${p.id} v${p.version}: price, period and overage terms are fixed once a version exists ` +
                `(they become the on-chain plan the customer signs). Bump the version to change them.`,
            );
          }
          versionId = prev.id;
          const same = canonical(prev.document) === canonical(p);
          await tx.update(planVersions).set(versionRow).where(eq(planVersions.id, versionId));
          await tx.delete(planItems).where(eq(planItems.planVersionId, versionId));
          changes.push({ kind: "plan_version", id: `${p.id}@${p.version}`, action: same ? "unchanged" : "update" });
        } else {
          versionId = newId("pv");
          await tx.insert(planVersions).values({ id: versionId, ...scope, planId: p.id, version: p.version, ...versionRow });
          changes.push({ kind: "plan_version", id: `${p.id}@${p.version}`, action: "create" });
        }

        if (p.items.length) {
          await tx.insert(planItems).values(
            p.items.map((i) => ({
              id: newId("pi"),
              planVersionId: versionId,
              featureId: i.feature,
              included: i.included,
              resetKind: i.reset === "period" ? ("period" as const) : i.reset === "never" ? ("never" as const) : ("every" as const),
              resetHours: typeof i.reset === "number" ? i.reset : null,
              overagePrice: i.overage ? BigInt(i.overage.price) : null,
              overagePer: i.overage?.per ?? null,
              overageCap: i.overage ? BigInt(i.overage.cap) : null,
              autoTopUpBelow: i.autoTopUp?.below ?? null,
              autoTopUpQuantity: i.autoTopUp?.quantity ?? null,
              autoTopUpPrice: i.autoTopUp ? BigInt(i.autoTopUp.price) : null,
              autoTopUpMaxPerPeriod: i.autoTopUp?.maxPerPeriod ?? null,
            })),
          );
        }
      }

      // Top-up prices and the wallet that receives one-off payments.
      const [prevSettings] = await tx.select().from(envSettings).where(and(eq(envSettings.orgId, scope.orgId), eq(envSettings.env, scope.env)));
      const sameSettings = prevSettings && prevSettings.payTo === doc.payTo && canonical(prevSettings.topUps) === canonical(doc.topUps);
      if (prevSettings || doc.payTo !== null || doc.topUps.length > 0) {
        changes.push({ kind: "settings", id: "topUps, payTo", action: !prevSettings ? "create" : sameSettings ? "unchanged" : "update" });
      }
      await tx
        .insert(envSettings)
        .values({ ...scope, payTo: doc.payTo, topUps: doc.topUps })
        .onConflictDoUpdate({ target: [envSettings.orgId, envSettings.env], set: { payTo: doc.payTo, topUps: doc.topUps, updatedAt: new Date() } });

      if (opts.dryRun) throw DRY;
    });
  } catch (e) {
    if (e !== DRY) throw e;
  }
  return { changes, dryRun: opts.dryRun ?? false };
}

export async function loadCatalog(tx: DbOrTx, scope: Scope): Promise<Catalog> {
  const [fs, rs] = await Promise.all([
    tx
      .select({ id: features.id, type: features.type })
      .from(features)
      .where(and(eq(features.orgId, scope.orgId), eq(features.env, scope.env), isNull(features.archivedAt))),
    tx.select().from(creditRates).where(and(eq(creditRates.orgId, scope.orgId), eq(creditRates.env, scope.env))),
  ]);
  return {
    features: new Map<string, FeatureDef>(fs.map((f) => [f.id, f])),
    creditRates: new Map(rs.map((r) => [r.meteredFeatureId, { creditFeatureId: r.creditFeatureId, rate: qty(r.creditsPerUnit) }])),
  };
}

/** The version to attach: a given one, or the newest active version of the plan. */
export async function findPlanVersion(tx: DbOrTx, scope: Scope, planId: string, version?: number) {
  const rows = await tx
    .select()
    .from(planVersions)
    .where(
      and(
        eq(planVersions.orgId, scope.orgId),
        eq(planVersions.env, scope.env),
        eq(planVersions.planId, planId),
        version === undefined ? inArray(planVersions.status, ["active"]) : eq(planVersions.version, version),
      ),
    )
    .orderBy(sql`${planVersions.version} desc`)
    .limit(1);
  const pv = rows[0];
  if (!pv) throw new NummoError("plan_not_found", version === undefined ? `no active version of plan ${planId}` : `plan ${planId} v${version} not found`);
  return pv;
}

export async function findDefaultPlanVersion(tx: DbOrTx, scope: Scope) {
  const [pv] = await tx
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.orgId, scope.orgId), eq(planVersions.env, scope.env), eq(planVersions.isDefault, true)))
    .limit(1);
  return pv ?? null;
}
