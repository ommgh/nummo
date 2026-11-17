/**
 * The customer portal (doc 04, "Customer portal"): the plan, its on-chain
 * ceiling, usage this period, receipts with links to each transaction, plan
 * changes, top-ups, and cancel or resume signed by the customer's own wallet.
 *
 * Like a checkout, a portal session is keyed only by its long random id, and
 * the merchant's backend creates it for a customer it has authenticated.
 * Cancel and resume are transactions the wallet signs and the puller pays the
 * fee for; the server builds them, checks the signed copy byte for byte, and
 * applies the result from the chain straight away.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { describePeriod, formatBaseUnits, formatQty, qty } from "@usenummo/core";
import type { TopUpDoc } from "@usenummo/config";
import {
  attach,
  createTopUp,
  type Db,
  getCustomer,
  loadEnvSettings,
  newId,
  NummoError,
  preview,
  schema,
  type Scope,
  upsertCustomer,
} from "@usenummo/db";
import { ActivationRejected, type Chain } from "@usenummo/solana";
import type { Chains } from "./chains.ts";
import { describeFailure, waitForOutcome } from "./confirm.ts";
import type { SettlementSettings } from "./settings.ts";
import { applyOnchainState } from "./settle.ts";

const { customers, orgs, plans, planVersions, portalSessions, subscriptions } = schema;

/** How long a portal link works. The merchant creates a new one each time the customer opens billing. */
export const PORTAL_TTL_MS = 60 * 60_000;

type Pending = { action: "cancel" | "resume"; subscriptionId: string; wallet: string; message: string; lastValidBlockHeight: string };

/** POST /v1/portal */
export async function createPortalSession(db: Db, scope: Scope, input: { customerId: string; returnUrl?: string }, publicUrl: string) {
  const [c] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.orgId, scope.orgId), eq(customers.env, scope.env), eq(customers.id, input.customerId)));
  if (!c) await upsertCustomer(db, scope, { id: input.customerId });
  const id = newId("ps");
  const expiresAt = new Date(Date.now() + PORTAL_TTL_MS);
  await db.insert(portalSessions).values({ id, ...scope, customerId: input.customerId, returnUrl: input.returnUrl ?? null, expiresAt });
  return { url: `${publicUrl}/portal/${id}`, expiresAt: expiresAt.toISOString() };
}

async function loadPortal(db: Db, id: string) {
  const [row] = await db
    .select({ p: portalSessions, org: orgs })
    .from(portalSessions)
    .innerJoin(orgs, eq(orgs.id, portalSessions.orgId))
    .where(eq(portalSessions.id, id));
  if (!row || row.p.expiresAt <= new Date()) throw new NummoError("portal_not_found", "This billing link has expired. Open billing again from the app.");
  return { ...row, scope: { orgId: row.p.orgId, env: row.p.env } as Scope };
}

/** GET /portal/:id/data: everything the portal page shows. */
export async function getPortal(db: Db, chains: Chains, id: string) {
  const { p, org, scope } = await loadPortal(db, id);
  const chain = chains[scope.env];
  const customer = await getCustomer(db, scope, p.customerId);
  const { topUps } = await loadEnvSettings(db, scope);

  // Plans the customer can move to: the newest active version of each main plan, published if paid.
  const versions = await db
    .select({ pv: planVersions, plan: plans })
    .from(planVersions)
    .innerJoin(plans, and(eq(plans.orgId, planVersions.orgId), eq(plans.env, planVersions.env), eq(plans.id, planVersions.planId)))
    .where(and(eq(planVersions.orgId, scope.orgId), eq(planVersions.env, scope.env), eq(planVersions.status, "active"), eq(plans.isAddon, false)))
    .orderBy(asc(planVersions.planId), asc(planVersions.version));
  const newest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) newest.set(v.pv.planId, v);
  const available = [...newest.values()]
    .filter(({ pv }) => pv.ceilingAmount === null || pv.onchainPlanPda !== null)
    .sort((a, b) => (a.pv.baseAmount < b.pv.baseAmount ? -1 : a.pv.baseAmount > b.pv.baseAmount ? 1 : 0))
    .map(({ pv }) => ({
      planId: pv.planId,
      version: pv.version,
      name: pv.name,
      price: pv.periodHours ? { amount: formatBaseUnits(pv.baseAmount), period: describePeriod(pv.periodHours) } : null,
      ceiling: pv.ceilingAmount !== null ? formatBaseUnits(pv.ceilingAmount) : null,
      current: customer.subscriptions.some((s) => s.planId === pv.planId && s.version === pv.version && ["active", "past_due", "canceling"].includes(s.status) && !s.replacedBy),
    }));

  return {
    merchant: org.name,
    network: chain?.network ?? null,
    returnUrl: p.returnUrl,
    expiresAt: p.expiresAt.toISOString(),
    customer,
    plans: available,
    topUps: topUps.map((t: TopUpDoc) => ({
      featureId: t.feature,
      price: formatBaseUnits(BigInt(t.price)),
      per: formatQty(qty(t.per)),
      min: formatBaseUnits(BigInt(t.min)),
      max: formatBaseUnits(BigInt(t.max)),
    })),
  };
}

function chainFor(chains: Chains, scope: Scope): Chain {
  const c = chains[scope.env];
  if (!c) throw new NummoError("settlement_unavailable", `settlement is not configured for the ${scope.env} environment`);
  return c;
}

/** POST /portal/:id/transaction { action, subscriptionId, wallet }: build cancel or resume for the wallet to sign. */
export async function preparePortalAction(db: Db, chains: Chains, id: string, input: { action: "cancel" | "resume"; subscriptionId: string; wallet: string }) {
  const { p, scope } = await loadPortal(db, id);
  const chain = chainFor(chains, scope);
  const [row] = await db
    .select({ sub: subscriptions, pv: planVersions })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .where(
      and(
        eq(subscriptions.id, input.subscriptionId),
        eq(subscriptions.orgId, scope.orgId),
        eq(subscriptions.env, scope.env),
        eq(subscriptions.customerId, p.customerId),
        inArray(subscriptions.status, ["active", "past_due", "canceling"]),
      ),
    );
  if (!row || !row.sub.subscriptionPda || !row.pv.onchainPlanPda) throw new NummoError("not_found", "no paid subscription to change");
  if (row.sub.replacedBy) throw new NummoError("invalid_request", "this subscription was replaced by a plan change and ends on its own");
  if (input.wallet !== row.sub.wallet) throw new NummoError("wrong_wallet", `Connect the wallet that pays for this plan: ${row.sub.wallet}`);

  const onchain = await chain.getSubscription(row.sub.subscriptionPda);
  if (!onchain) throw new NummoError("invalid_request", "the on-chain subscription no longer exists");
  let built;
  if (input.action === "cancel") {
    if (onchain.expiresAt) throw new NummoError("invalid_request", "this subscription is already cancelled");
    built = await chain.buildCancel({ plan: row.pv.onchainPlanPda, subscriber: input.wallet });
  } else {
    if (!onchain.expiresAt) throw new NummoError("invalid_request", "this subscription is not cancelled");
    built = await chain.buildResume({ plan: row.pv.onchainPlanPda, subscriber: input.wallet, expiresAt: onchain.expiresAt });
  }
  const pending: Pending = {
    action: input.action,
    subscriptionId: row.sub.id,
    wallet: input.wallet,
    message: built.message,
    lastValidBlockHeight: built.lastValidBlockHeight.toString(),
  };
  await db.update(portalSessions).set({ pending }).where(eq(portalSessions.id, id));
  return { transaction: built.transaction };
}

/** POST /portal/:id/submit { signedTransaction }: co-sign, send, and apply the on-chain result. */
export async function submitPortalAction(db: Db, chains: Chains, settings: SettlementSettings, id: string, signedTransaction: string) {
  const { p, scope } = await loadPortal(db, id);
  const chain = chainFor(chains, scope);
  const pending = p.pending as Pending | null;
  if (!pending) throw new NummoError("invalid_request", "connect a wallet and request the transaction first");
  const lvbh = BigInt(pending.lastValidBlockHeight);
  if ((await chain.getBlockHeight()) > lvbh) throw new NummoError("activation_rejected", "The transaction expired before it was signed. Try again.");

  let prepared;
  try {
    prepared = await chain.cosign(signedTransaction, pending.message, pending.wallet, lvbh);
  } catch (e) {
    if (e instanceof ActivationRejected) throw new NummoError("activation_rejected", e.message);
    throw e;
  }
  await db.update(portalSessions).set({ pending: null }).where(eq(portalSessions.id, id));

  const sent = await chain.send(prepared);
  const outcome = !sent.ok && sent.definite ? { state: "failed" as const, error: sent.error } : await waitForOutcome(chain, prepared.signature, lvbh, settings.confirmWaitMs, settings.pollMs);
  if (outcome.state === "failed") throw new NummoError("activation_rejected", describeFailure(outcome.error));
  if (outcome.state === "expired") throw new NummoError("activation_rejected", "The transaction expired before it landed. Try again.");

  // Apply what the chain now says (the reconciler would also pick it up within minutes).
  if (outcome.state === "confirmed") {
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, pending.subscriptionId));
    if (sub?.subscriptionPda && sub.wallet) {
      const onchain = await chain.getSubscription(sub.subscriptionPda);
      await applyOnchainState(db, sub, onchain, onchain ? await chain.getAuthority(sub.wallet) : null);
    }
  }
  return { signature: prepared.signature, confirmed: outcome.state === "confirmed", portal: await getPortal(db, chains, id) };
}

/** POST /portal/:id/change { planId }: preview or start a plan change for this customer. */
export async function portalChange(db: Db, id: string, input: { planId: string; confirm: boolean }, publicUrl: string) {
  const { p, scope } = await loadPortal(db, id);
  if (!input.confirm) return { preview: await preview(db, scope, { customerId: p.customerId, planId: input.planId }) };
  const r = await attach(db, scope, { customerId: p.customerId, planId: input.planId, successUrl: `${publicUrl}/portal/${id}` }, { publicUrl });
  return { result: r };
}

/** POST /portal/:id/topup { featureId, amount }: a checkout for a one-off purchase, returning to the portal. */
export async function portalTopUp(db: Db, chains: Chains, id: string, input: { featureId: string; amount: bigint }, publicUrl: string) {
  const { p, scope } = await loadPortal(db, id);
  const chain = chainFor(chains, scope);
  return createTopUp(
    db,
    scope,
    { customerId: p.customerId, featureId: input.featureId, amount: input.amount, successUrl: `${publicUrl}/portal/${id}` },
    { publicUrl, reference: () => chain.newReference() },
  );
}
