/**
 * The HTTP API (doc 04, REST endpoints). Bodies are JSON; quantities and
 * amounts are decimal strings. Errors are { "error": { "code", "message" } }.
 * A refused `check` is a 200 with `allowed: false`, not an error.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  applyConfig,
  attach,
  NummoError,
  check,
  finalize,
  getCustomer,
  grantBalance,
  listEvents,
  listInvoices,
  resolveApiKey,
  track,
  trackBatch,
  upsertCustomer,
  type Db,
  type Scope,
} from "@usenummo/db";
import {
  type Chains,
  defaultSettings,
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

const decimal = z.string().regex(/^\d+(\.\d{1,9})?$/, "a non-negative decimal string with up to 9 places");
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
  publish: z.object({ address: z.string().min(32).max(64) }),
  webhook: z.object({ url: z.url() }),
  checkoutTx: z.object({ wallet: z.string().min(1).max(64) }),
  checkoutSubmit: z.object({ signedTransaction: z.string().min(1).max(4096) }),
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
      return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  app.get("/health", (c) => c.json({ ok: true }));

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
    if (!scope) throw new NummoError("unauthorized", "missing or invalid API key");
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

  v1.post("/balances/finalize", async (c) => c.json(await finalize(db, c.get("scope"), await body(c, schemas.finalize))));

  v1.post("/balances", async (c) => {
    const b = await body(c, schemas.grant);
    return c.json(await grantBalance(db, c.get("scope"), { ...b, expiresAt: b.expiresAt ? new Date(b.expiresAt) : null }), 201);
  });

  v1.post("/attach", async (c) => {
    const b = await body(c, schemas.attach);
    return c.json(await attach(db, c.get("scope"), b, { publicUrl: settings.publicUrl }));
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

  // Planned for later milestones (doc 05). Explicit, so clients get a clear answer.
  for (const [method, path, milestone] of [
    ["post", "/preview", "M3"],
    ["post", "/topups", "M3"],
    ["post", "/portal", "M3"],
  ] as const) {
    v1[method](path, () => {
      throw new NummoError("not_implemented", `${path} arrives in milestone ${milestone}`);
    });
  }

  app.route("/v1", v1);
  return app;
}
