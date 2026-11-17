/**
 * The merchant dashboard's JSON API (doc 05, M3), mounted at /dashboard/api.
 * The dashboard itself is the React app in apps/web, served by web.ts.
 *
 * Sign-in is a Better Auth session (auth.ts): the user's active organization is
 * the nummo org, and the x-nummo-env header picks test (devnet) or live
 * (mainnet) data. Every write must be JSON: a cross-site form cannot send that
 * without a CORS preflight, which this API never answers.
 *
 * Publishing a plan uses the merchant's browser wallet: the server builds
 * createPlan with the merchant as fee payer, the wallet signs, the server sends
 * it, then checks the plan on-chain exactly as `nummo plans publish` does.
 */

import { Hono, type Context } from "hono";
import {
  createApiKey,
  type Db,
  ensureOrg,
  type Env,
  getCustomer,
  grantBalance,
  getOrganization,
  listApiKeys,
  listCustomers,
  listEvents,
  listPayments,
  memberRole,
  NummoError,
  overview,
  revokeApiKey,
  type Scope,
  usageDaily,
  webhookStatus,
} from "@usenummo/db";
import {
  type Chains,
  createPortalSession,
  listPlanVersions,
  registerPublishedPlan,
  type SettlementSettings,
  waitForOutcome,
} from "@usenummo/settlement";
import { ActivationRejected } from "@usenummo/solana";
import type { Auth } from "./auth.ts";

type Session = Scope & { org: string; role: string; user: { id: string; name: string; email: string; image: string | null } };
type Vars = { Variables: { session: Session } };

export function dashboardApi(db: Db, chains: Chains, settings: SettlementSettings, auth: Auth) {
  const app = new Hono<Vars>();

  app.onError((err, c) => {
    if (err instanceof NummoError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    console.error(err);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  // JSON-only writes: the CSRF defence, together with SameSite=Strict.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !c.req.header("content-type")?.startsWith("application/json")) {
      throw new NummoError("invalid_request", "send JSON (content-type: application/json)");
    }
    await next();
  });

  const json = async <T>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new NummoError("invalid_request", "the body is not valid JSON");
    }
  };

  // ---------------------------------------------------------------- session

  const envOf = (c: Context): Env => (c.req.header("x-nummo-env") === "live" ? "live" : "test");

  // Which sign-in methods the sign-in page should offer. Public.
  app.get("/providers", (c) =>
    c.json({
      email: true,
      github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    }),
  );

  // Who is signed in, and to which organization. Answers before the org check so
  // the app can send a new user to create their organization.
  app.get("/session", async (c) => {
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!s) throw new NummoError("unauthorized", "sign in first");
    const orgId = s.session.activeOrganizationId ?? null;
    const role = orgId ? await memberRole(db, s.user.id, orgId) : null;
    const org = orgId && role ? await getOrganization(db, orgId) : null;
    const env = envOf(c);
    const chain = chains[env];
    return c.json({
      user: { id: s.user.id, name: s.user.name, email: s.user.email, image: s.user.image ?? null },
      org: org ? { id: org.id, name: org.name, slug: org.slug, role } : null,
      env,
      settlement: chain ? { network: chain.network, mint: chain.mint, puller: chain.pullerAddress } : null,
      publicUrl: settings.publicUrl,
    });
  });

  app.use("*", async (c, next) => {
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!s) throw new NummoError("unauthorized", "sign in first");
    const orgId = s.session.activeOrganizationId;
    const role = orgId ? await memberRole(db, s.user.id, orgId) : null;
    if (!orgId || !role) throw new NummoError("forbidden", "choose or create an organization first");
    const org = await getOrganization(db, orgId);
    await ensureOrg(db, orgId, org?.name ?? orgId);
    c.set("session", {
      orgId,
      env: envOf(c),
      org: org?.name ?? orgId,
      role,
      user: { id: s.user.id, name: s.user.name, email: s.user.email, image: s.user.image ?? null },
    });
    await next();
  });

  const canManage = (c: Context<Vars>) => ["owner", "admin"].includes(c.get("session").role);

  const scopeOf = (c: Context<Vars>): Scope => ({ orgId: c.get("session").orgId, env: c.get("session").env });
  const chainOf = (c: Context<Vars>) => chains[c.get("session").env];

  // ---------------------------------------------------------------- reports

  app.get("/overview", async (c) => {
    const scope = scopeOf(c);
    const [o, w, u] = await Promise.all([overview(db, scope), webhookStatus(db, scope), usageDaily(db, scope)]);
    // Activity: the latest events the merchant's webhook endpoint receives (or would).
    const activity = w.events.slice(0, 8).map((e) => ({ type: e.type, createdAt: e.createdAt, state: e.state, payload: e.payload }));
    return c.json({ ...o, activity, usageDaily: u });
  });

  app.get("/customers", async (c) => {
    const search = c.req.query("q") || undefined;
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return c.json(await listCustomers(db, scopeOf(c), { search, limit, offset }));
  });

  app.get("/customers/:id", async (c) => {
    const scope = scopeOf(c);
    const id = c.req.param("id");
    const [customer, events] = await Promise.all([getCustomer(db, scope, id), listEvents(db, scope, { customerId: id, limit: 50 })]);
    return c.json({ customer, events });
  });

  app.post("/customers/:id/portal", async (c) => {
    return c.json(await createPortalSession(db, scopeOf(c), { customerId: c.req.param("id") }, settings.publicUrl));
  });

  app.post("/customers/:id/grant", async (c) => {
    const b = await json<{ featureId?: string; amount?: string }>(c);
    await grantBalance(db, scopeOf(c), { customerId: c.req.param("id"), featureId: String(b.featureId ?? ""), amount: String(b.amount ?? "") });
    return c.json({ ok: true });
  });

  app.get("/payments", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 500);
    return c.json({ payments: await listPayments(db, scopeOf(c), { limit }) });
  });

  app.get("/usage", async (c) => {
    const scope = scopeOf(c);
    const featureId = c.req.query("feature") || undefined;
    const [o, daily, events] = await Promise.all([overview(db, scope), usageDaily(db, scope, { features: 6 }), listEvents(db, scope, { featureId, limit: 200 })]);
    return c.json({ features: o.usage, daily, events });
  });

  app.get("/webhooks", async (c) => c.json(await webhookStatus(db, scopeOf(c))));

  // ---------------------------------------------------------------- API keys

  app.get("/keys", async (c) => c.json({ keys: await listApiKeys(db, c.get("session").orgId) }));

  app.post("/keys", async (c) => {
    if (!canManage(c)) throw new NummoError("forbidden", "only owners and admins can create keys");
    const b = await json<{ env?: string }>(c);
    if (b.env !== "test" && b.env !== "live") throw new NummoError("invalid_request", "env must be test or live");
    const k = await createApiKey(db, c.get("session").orgId, b.env);
    return c.json({ id: k.id, key: k.key, env: b.env });
  });

  app.post("/keys/:id/revoke", async (c) => {
    if (!canManage(c)) throw new NummoError("forbidden", "only owners and admins can revoke keys");
    if (!(await revokeApiKey(db, c.get("session").orgId, c.req.param("id")))) throw new NummoError("not_found", "no active key by that id");
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- plans and publishing

  app.get("/plans", async (c) => c.json(await listPlanVersions(db, scopeOf(c), chainOf(c), settings.publicUrl)));

  app.post("/plans/:planId/:version/transaction", async (c) => {
    const scope = scopeOf(c);
    const chain = chains[scope.env];
    if (!chain) throw new NummoError("settlement_unavailable", "settlement is not configured for this environment");
    const { owner } = await json<{ owner: string }>(c);
    const { versions } = await listPlanVersions(db, scope, chain, settings.publicUrl);
    const v = versions.find((x) => x.planId === c.req.param("planId") && x.version === Number(c.req.param("version")));
    if (!v?.onchainTerms) throw new NummoError("plan_not_found", "no paid plan version by that name");
    if (v.published) throw new NummoError("invalid_request", "already published");
    const t = v.onchainTerms;
    const built = await chain.buildCreatePlan({ owner, planId: BigInt(t.planId), amount: BigInt(t.amount), periodHours: t.periodHours!, metadataUri: t.metadataUri });
    return c.json({ transaction: built.transaction, message: built.message, lastValidBlockHeight: built.lastValidBlockHeight.toString(), planAddress: built.planAddress });
  });

  app.post("/plans/:planId/:version/submit", async (c) => {
    const scope = scopeOf(c);
    const chain = chains[scope.env];
    if (!chain) throw new NummoError("settlement_unavailable", "settlement is not configured for this environment");
    const b = await json<{ owner: string; signedTransaction: string; message: string; lastValidBlockHeight: string; planAddress: string }>(c);
    // The message comes back from the browser: what keeps this honest is the on-chain check in registerPublishedPlan.
    let prepared;
    try {
      prepared = await chain.cosign(b.signedTransaction, b.message, b.owner, BigInt(b.lastValidBlockHeight));
    } catch (e) {
      if (e instanceof ActivationRejected) throw new NummoError("activation_rejected", e.message);
      throw e;
    }
    const sent = await chain.send(prepared);
    if (!sent.ok && sent.definite) throw new NummoError("activation_rejected", sent.error.message);
    const o = await waitForOutcome(chain, prepared.signature, prepared.lastValidBlockHeight, 60_000, 1_500);
    if (o.state !== "confirmed") throw new NummoError("activation_rejected", o.state === "failed" ? o.error.message : `the transaction is ${o.state}`);
    const r = await registerPublishedPlan(db, chain, scope, c.req.param("planId"), Number(c.req.param("version")), b.planAddress);
    return c.json({ ...r, signature: prepared.signature });
  });

  return app;
}
