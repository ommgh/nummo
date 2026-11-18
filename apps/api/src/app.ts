/**
 * The HTTP API (doc 04, REST endpoints). Bodies are JSON; quantities and
 * amounts are decimal strings. Errors are { "error": { "code", "message" } }.
 * A refused `check` is a 200 with `allowed: false`, not an error.
 */

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { AgentPayments } from "@usenummo/agents";
import {
  applyConfig,
  attach,
  NummoError,
  check,
  checkTokens,
  trackTokens,
  createTopUp,
  finalize,
  getCustomer,
  grantBalance,
  listCustomers,
  listEvents,
  listInvoices,
  preview,
  resolveApiKey,
  track,
  trackBatch,
  upsertCustomer,
  type Db,
  type Scope,
} from "@usenummo/db";
import {
  type Chains,
  createPortalSession,
  defaultSettings,
  getPortal,
  portalChange,
  portalTopUp,
  preparePortalAction,
  submitPortalAction,
  deleteWebhookEndpoint,
  getCheckout,
  getWebhookEndpoint,
  listPlanVersions,
  planMetadata,
  prepareCheckoutTransaction,
  registerPublishedPlan,
  type SettlementSettings,
  setWebhookEndpoint,
  submitCheckout,
  verify,
} from "@usenummo/settlement";
import { CHECKOUT_PAGE } from "./checkout-page.ts";
import { PORTAL_PAGE } from "./portal-page.ts";
import { dashboardApi } from "./dashboard.ts";
import { webApp } from "./web.ts";
import { type Auth, createAuth } from "./auth.ts";
import { clientIp, clientIpHeader, limitByIp, limited, type RateLimits, rateLimitsFromEnv, TokenBuckets } from "./rate-limit.ts";

const decimal = z.string().regex(/^\d+(\.\d{1,9})?$/, "a non-negative decimal string with up to 9 places");
/** Amounts in requests are integer strings of token base units (doc 04): "10000000" is 10 USDC. */
const baseUnits = z.string().regex(/^\d{1,20}$/, "an integer string of token base units");
const id = z.string().min(1).max(255);
const props = z.record(z.string(), z.unknown()).optional();

const schemas = {
  check: z.object({
    customerId: id,
    featureId: id,
    requiredBalance: decimal.optional(),
    sendEvent: z.boolean().optional(),
    idempotencyKey: id.optional(),
    properties: props,
    lock: z.object({ lockId: id, expiresAt: z.union([z.number().int(), z.iso.datetime()]) }).optional(),
  }),
  track: z.object({
    customerId: id,
    featureId: id,
    value: decimal.default("1"),
    idempotencyKey: id.optional(),
    properties: props,
    occurredAt: z.iso.datetime().optional(),
  }),
  finalize: z.object({
    lockId: id,
    action: z.enum(["confirm", "release"]),
    overrideValue: decimal.optional(),
    properties: props,
  }),
  attach: z.object({
    customerId: id,
    planId: id,
    version: z.number().int().positive().optional(),
    successUrl: z.url().optional(),
    skipPayment: z.boolean().optional(),
  }),
  grant: z.object({
    customerId: id,
    featureId: id,
    amount: decimal,
    source: z.enum(["manual", "reward", "topup"]).optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  }),
  customer: z.object({ name: z.string().nullable().optional(), email: z.email().nullable().optional() }),
  preview: z.object({ customerId: id, planId: id, version: z.number().int().positive().optional() }),
  topup: z.object({ customerId: id, featureId: id, amount: baseUnits, successUrl: z.url().optional() }),
  portal: z.object({ customerId: id, returnUrl: z.url().optional() }),
  portalAction: z.object({ action: z.enum(["cancel", "resume"]), subscriptionId: id, wallet: z.string().min(1).max(64) }),
  portalChange: z.object({ planId: id, confirm: z.boolean().default(false) }),
  portalTopUp: z.object({ featureId: id, amount: baseUnits }),
  publish: z.object({ address: z.string().min(32).max(64) }),
  webhook: z.object({ url: z.url() }),
  checkoutTx: z.object({ wallet: z.string().min(1).max(64) }),
  checkoutSubmit: z.object({ signedTransaction: z.string().min(1).max(4096) }),
  pay: z.object({
    request: z.object({
      method: z.string().min(1).max(16),
      url: z.url().max(4096),
      headers: z.record(z.string(), z.string().max(16_384)).default({}),
    }),
    featureId: id,
    value: decimal.optional(),
    customerId: id.optional(),
    idempotencyKey: id.optional(),
    properties: props,
    description: z.string().max(200).optional(),
  }),
  tokens: z.object({
    customerId: id,
    model: z.string().min(1).max(128),
    usage: z.object({ input: decimal.optional(), output: decimal.optional(), cachedInput: decimal.optional() }),
    idempotencyKey: id.optional(),
    properties: props,
    occurredAt: z.iso.datetime().optional(),
  }),
};

type Vars = { Variables: { scope: Scope } };

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new NummoError("invalid_request", "body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new NummoError(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

const toDate = (v: number | string) => new Date(typeof v === "number" ? v : Date.parse(v));

export type AppOptions = {
  /** Chains per environment. Without one, checkout, publishing and verify answer settlement_unavailable. */
  chains?: Chains;
  settings?: SettlementSettings;
  /** The built web app (apps/web/dist by default); null serves a note instead. */
  webDir?: string | null;
  /** Dashboard accounts; created from the settings when omitted. */
  auth?: Auth;
  /** x402 and MPP payments per request. Without it, /v1/pay answers settlement_unavailable. */
  agents?: AgentPayments;
  /** Request limits (./rate-limit.ts); read from the environment when omitted, false turns them off. */
  rateLimits?: RateLimits | false;
};

export function createApp(db: Db, opts: AppOptions = {}) {
  const app = new Hono<Vars>();
  const chains: Chains = opts.chains ?? {};
  const settings = opts.settings ?? defaultSettings();
  const chainFor = (scope: Scope) => {
    const c = chains[scope.env];
    if (!c) throw new NummoError("settlement_unavailable", `settlement is not configured for the ${scope.env} environment (set NUMMO_${scope.env.toUpperCase()}_PULLER_KEY)`);
    return c;
  };

  app.onError((err, c) => {
    if (err instanceof NummoError) {
      if (err.code === "rate_limited") c.header("Retry-After", String((err.details as { retryAfter?: number })?.retryAfter ?? 1));
      return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  app.get("/health", (c) => c.json({ ok: true }));
  // For uptime monitors: also proves the database answers. /health stays cheap for the platform's deploy check.
  app.get("/health/deep", async (c) => {
    const started = Date.now();
    try {
      await (db as unknown as { $client: { query(q: string): Promise<unknown> } }).$client.query("select 1");
      return c.json({ ok: true, db: "ok", dbMs: Date.now() - started });
    } catch (err) {
      console.error("health/deep: database check failed", err);
      return c.json({ ok: false, db: "down" }, 503);
    }
  });

  const limits = opts.rateLimits ?? rateLimitsFromEnv();
  const ipHeader = clientIpHeader();
  const apiBuckets = limits ? new TokenBuckets(limits.api) : null;
  const badKeyBuckets = limits ? new TokenBuckets(limits.badKey) : null;
  if (limits) {
    const read = limitByIp(new TokenBuckets(limits.public), ipHeader);
    const write = limitByIp(new TokenBuckets(limits.chain), ipHeader);
    const publicPages: MiddlewareHandler = (c, next) => (c.req.method === "POST" ? write(c, next) : read(c, next));
    app.use("/checkout/*", publicPages);
    app.use("/portal/*", publicPages);
    app.use("/p/*", read);
    app.use("/dashboard/api/*", limitByIp(new TokenBuckets(limits.dashboard), ipHeader));
  }

  // ---------------------------------------------------------------- hosted checkout (public, keyed by session id)

  app.get("/checkout/:id", (c) => c.html(CHECKOUT_PAGE));
  app.get("/checkout/:id/session", async (c) => c.json(await getCheckout(db, chains, c.req.param("id"))));
  app.post("/checkout/:id/transaction", async (c) => {
    const b = await body(c, schemas.checkoutTx);
    return c.json(await prepareCheckoutTransaction(db, chains, c.req.param("id"), b.wallet));
  });
  app.post("/checkout/:id/submit", async (c) => {
    const b = await body(c, schemas.checkoutSubmit);
    return c.json(await submitCheckout(db, chains, settings, c.req.param("id"), b.signedTransaction));
  });
  // ---------------------------------------------------------------- customer portal (public, keyed by session id)

  app.get("/portal/:id", (c) => c.html(PORTAL_PAGE));
  app.get("/portal/:id/data", async (c) => c.json(await getPortal(db, chains, c.req.param("id"))));
  app.post("/portal/:id/transaction", async (c) => {
    const b = await body(c, schemas.portalAction);
    return c.json(await preparePortalAction(db, chains, c.req.param("id"), b));
  });
  app.post("/portal/:id/submit", async (c) => {
    const b = await body(c, schemas.checkoutSubmit);
    return c.json(await submitPortalAction(db, chains, settings, c.req.param("id"), b.signedTransaction));
  });
  app.post("/portal/:id/change", async (c) => {
    const b = await body(c, schemas.portalChange);
    return c.json(await portalChange(db, c.req.param("id"), b, settings.publicUrl));
  });
  app.post("/portal/:id/topup", async (c) => {
    const b = await body(c, schemas.portalTopUp);
    return c.json(await portalTopUp(db, chains, c.req.param("id"), { featureId: b.featureId, amount: BigInt(b.amount) }, settings.publicUrl));
  });

  // ---------------------------------------------------------------- merchant dashboard (cookie session)

  const auth = opts.auth ?? createAuth(db, { publicUrl: settings.publicUrl });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route("/dashboard/api", dashboardApi(db, chains, settings, auth));

  // On-chain plan metadata URI.
  app.get("/p/:id", async (c) => {
    const m = await planMetadata(db, c.req.param("id"));
    if (!m) throw new NummoError("not_found", "plan not found");
    return c.json(m);
  });

  const v1 = new Hono<Vars>();
  v1.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const scope = key ? await resolveApiKey(db, key) : null;
    if (!scope) {
      // Wrong keys are counted per IP; a valid key is never held back by them.
      const wait = badKeyBuckets?.take(clientIp(c, ipHeader));
      if (wait) limited(wait);
      throw new NummoError("unauthorized", "missing or invalid API key");
    }
    const wait = apiBuckets?.take(`${scope.orgId}:${scope.env}`);
    if (wait) limited(wait);
    c.set("scope", scope);
    await next();
  });

  v1.post("/check", async (c) => {
    const b = await body(c, schemas.check);
    const r = await check(db, c.get("scope"), {
      ...b,
      lock: b.lock ? { lockId: b.lock.lockId, expiresAt: toDate(b.lock.expiresAt) } : undefined,
    });
    return c.json(r);
  });

  v1.post("/track", async (c) => {
    const b = await body(c, schemas.track);
    return c.json(await track(db, c.get("scope"), { ...b, occurredAt: b.occurredAt ? new Date(b.occurredAt) : undefined }));
  });

  v1.post("/track/batch", async (c) => {
    const b = await body(c, z.object({ events: z.array(schemas.track).min(1).max(1000) }));
    const results = await trackBatch(
      db,
      c.get("scope"),
      b.events.map((e) => ({ ...e, occurredAt: e.occurredAt ? new Date(e.occurredAt) : undefined })),
    );
    return c.json({ results });
  });

  // Agent payments (M4): serve from a balance, answer with a 402 challenge, or settle a payment.
  const agents = opts.agents ?? new AgentPayments(db, {});
  v1.post("/pay", async (c) => {
    const b = await body(c, schemas.pay);
    return c.json(await agents.pay(c.get("scope"), b));
  });

  // Per-model token pricing (M4).
  v1.post("/track/tokens", async (c) => {
    const b = await body(c, schemas.tokens);
    return c.json(await trackTokens(db, c.get("scope"), { ...b, occurredAt: b.occurredAt ? new Date(b.occurredAt) : undefined }));
  });
  v1.post("/check/tokens", async (c) => {
    const b = await body(c, schemas.tokens.pick({ customerId: true, model: true, usage: true }));
    return c.json(await checkTokens(db, c.get("scope"), b));
  });

  v1.post("/balances/finalize", async (c) => c.json(await finalize(db, c.get("scope"), await body(c, schemas.finalize))));

  v1.post("/balances", async (c) => {
    const b = await body(c, schemas.grant);
    return c.json(await grantBalance(db, c.get("scope"), { ...b, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null }), 201);
  });

  v1.post("/attach", async (c) => {
    const b = await body(c, schemas.attach);
    return c.json(await attach(db, c.get("scope"), b, { publicUrl: settings.publicUrl }));
  });

  v1.post("/preview", async (c) => c.json(await preview(db, c.get("scope"), await body(c, schemas.preview))));

  v1.post("/topups", async (c) => {
    const b = await body(c, schemas.topup);
    const scope = c.get("scope");
    const chain = chainFor(scope);
    return c.json(
      await createTopUp(db, scope, { ...b, amount: BigInt(b.amount) }, { publicUrl: settings.publicUrl, reference: () => chain.newReference() }),
      201,
    );
  });

  v1.post("/portal", async (c) => {
    const b = await body(c, schemas.portal);
    return c.json(await createPortalSession(db, c.get("scope"), b, settings.publicUrl), 201);
  });

  v1.get("/customers", async (c) => {
    const q = c.req.query();
    return c.json(await listCustomers(db, c.get("scope"), { search: q.search, limit: q.limit ? Number(q.limit) : undefined, offset: q.offset ? Number(q.offset) : undefined }));
  });
  v1.get("/customers/:id", async (c) => c.json(await getCustomer(db, c.get("scope"), c.req.param("id"))));
  v1.put("/customers/:id", async (c) => {
    const b = await body(c, schemas.customer);
    return c.json(await upsertCustomer(db, c.get("scope"), { id: c.req.param("id"), ...b }));
  });
  v1.get("/customers/:id/invoices", async (c) => {
    await getCustomer(db, c.get("scope"), c.req.param("id")); // 404 for an unknown customer
    return c.json({ invoices: await listInvoices(db, c.get("scope"), c.req.param("id"), 100) });
  });

  v1.get("/plans", async (c) => c.json(await listPlanVersions(db, c.get("scope"), chains[c.get("scope").env], settings.publicUrl)));
  v1.post("/plans/:planId/versions/:version/publish", async (c) => {
    const b = await body(c, schemas.publish);
    const version = Number(c.req.param("version"));
    if (!Number.isInteger(version) || version < 1) throw new NummoError("invalid_request", "version must be a positive integer");
    const scope = c.get("scope");
    return c.json(await registerPublishedPlan(db, chainFor(scope), scope, c.req.param("planId"), version, b.address));
  });

  v1.get("/verify", async (c) => {
    const scope = c.get("scope");
    return c.json(await verify(db, chainFor(scope), scope));
  });

  v1.get("/webhook", async (c) => c.json({ endpoint: await getWebhookEndpoint(db, c.get("scope")) }));
  v1.put("/webhook", async (c) => {
    const b = await body(c, schemas.webhook);
    return c.json({ endpoint: await setWebhookEndpoint(db, c.get("scope"), b.url) });
  });
  v1.delete("/webhook", async (c) => {
    await deleteWebhookEndpoint(db, c.get("scope"));
    return c.json({ endpoint: null });
  });

  v1.get("/events", async (c) => {
    const q = c.req.query();
    const date = (s?: string) => (s ? new Date(s) : undefined);
    return c.json({
      events: await listEvents(db, c.get("scope"), {
        customerId: q.customerId,
        featureId: q.featureId,
        from: date(q.from),
        to: date(q.to),
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    });
  });

  v1.put("/config", async (c) => {
    const raw = await c.req.json().catch(() => {
      throw new NummoError("invalid_request", "body must be JSON");
    });
    const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
    return c.json(await applyConfig(db, c.get("scope"), raw, { dryRun }));
  });

  app.route("/v1", v1);
  // The website and the dashboard, last: they only answer GETs the routes above did not.
  app.route("/", webApp(opts.webDir));
  return app;
}
