/**
 * Publishing plan versions on-chain (doc 04, `nummo plans publish`).
 *
 * The merchant's wallet creates the on-chain plan, so that happens in the CLI,
 * never on our server. The server then checks the plan on-chain against the
 * version's terms before it accepts the address: a plan with the wrong ceiling,
 * period, mint or puller list would charge the wrong amount or fail every pull.
 */

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { describePeriod, formatBaseUnits } from "@usenummo/core";
import { type Db, NummoError, schema, type Scope } from "@usenummo/db";
import { type Chain, onchainPlanIdFor } from "@usenummo/solana";

const { planVersions } = schema;

/** The deterministic on-chain plan id for a plan version; publishing twice finds the same plan. */
export function planIdSeed(scope: Scope, planId: string, version: number) {
  return onchainPlanIdFor(`nummo:${scope.orgId}:${scope.env}:${planId}@${version}`);
}

/** GET /v1/plans: plan versions, their on-chain terms and publication state. */
export async function listPlanVersions(db: Db, scope: Scope, chain: Chain | undefined, publicUrl: string) {
  const rows = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.orgId, scope.orgId), eq(planVersions.env, scope.env)))
    .orderBy(asc(planVersions.planId), asc(planVersions.version));
  return {
    settlement: chain ? { network: chain.network, mint: chain.mint, puller: chain.pullerAddress } : null,
    versions: rows.map((pv) => ({
      planId: pv.planId,
      version: pv.version,
      name: pv.name,
      status: pv.status,
      paid: pv.ceilingAmount !== null,
      base: formatBaseUnits(pv.baseAmount),
      onchainTerms:
        pv.ceilingAmount !== null
          ? {
              amount: pv.ceilingAmount.toString(),
              periodHours: pv.periodHours,
              ceiling: formatBaseUnits(pv.ceilingAmount),
              period: describePeriod(pv.periodHours!),
              planId: planIdSeed(scope, pv.planId, pv.version).toString(),
              metadataUri: `${publicUrl}/p/${pv.id}`,
            }
          : null,
      published: pv.onchainPlanPda ? { address: pv.onchainPlanPda, owner: pv.onchainOwner, publishedAt: pv.publishedAt?.toISOString() ?? null } : null,
    })),
  };
}

/** POST /v1/plans/:planId/versions/:version/publish { address } */
export async function registerPublishedPlan(db: Db, chain: Chain, scope: Scope, planId: string, version: number, address: string) {
  const [pv] = await db
    .select()
    .from(planVersions)
    .where(and(eq(planVersions.orgId, scope.orgId), eq(planVersions.env, scope.env), eq(planVersions.planId, planId), eq(planVersions.version, version)));
  if (!pv) throw new NummoError("plan_not_found", `plan ${planId} v${version} not found`);
  if (pv.ceilingAmount === null || pv.periodHours === null) throw new NummoError("invalid_request", `plan ${planId} v${version} is free; nothing goes on-chain`);
  if (pv.onchainPlanPda && pv.onchainPlanPda !== address) {
    throw new NummoError("invalid_request", `plan ${planId} v${version} is already published at ${pv.onchainPlanPda}`);
  }

  const p = await chain.getPlan(address);
  const problems: string[] = [];
  if (!p) problems.push(`no plan account at ${address} on ${chain.network}`);
  else {
    if (p.amount !== pv.ceilingAmount) problems.push(`amount is ${p.amount}, expected the ceiling ${pv.ceilingAmount}`);
    if (p.periodHours !== pv.periodHours) problems.push(`period is ${p.periodHours}h, expected ${pv.periodHours}h`);
    if (p.mint !== chain.mint) problems.push(`mint is ${p.mint}, expected ${chain.mint}`);
    if (p.status !== "active") problems.push("plan is not active");
    if (p.endTs !== 0n) problems.push("plan has an end time; publish one without");
    if (!p.pullers.includes(chain.pullerAddress)) problems.push(`puller ${chain.pullerAddress} is not on the plan's puller list`);
    if (p.destinations.length !== 1 || p.destinations[0] !== p.owner) problems.push("destinations must be exactly the plan owner");
  }
  if (problems.length) throw new NummoError("invalid_request", `on-chain plan rejected: ${problems.join("; ")}`);

  const [u] = await db
    .update(planVersions)
    .set({ onchainPlanPda: address, onchainPlanId: p!.planId.toString(), onchainOwner: p!.owner, mintAddress: p!.mint, publishedAt: new Date() })
    .where(eq(planVersions.id, pv.id))
    .returning();
  return { planId, version, address: u!.onchainPlanPda, owner: u!.onchainOwner, mint: u!.mintAddress };
}

/** Public plan metadata, served at the plan's metadata URI. */
export async function planMetadata(db: Db, planVersionId: string) {
  const [pv] = await db.select().from(planVersions).where(and(eq(planVersions.id, planVersionId), isNotNull(planVersions.ceilingAmount)));
  if (!pv) return null;
  return {
    name: pv.name,
    plan: pv.planId,
    version: pv.version,
    base: formatBaseUnits(pv.baseAmount),
    ceiling: formatBaseUnits(pv.ceilingAmount!),
    period: describePeriod(pv.periodHours!),
  };
}
