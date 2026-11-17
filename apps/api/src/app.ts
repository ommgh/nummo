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
  BillError,
  check,
  finalize,
  getCustomer,
  grantBalance,
  listEvents,
  resolveApiKey,
  track,
  trackBatch,
  upsertCustomer,
  type Db,
  type Scope,
} from "@bill/db";

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
};

type Vars = { Variables: { scope: Scope } };

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BillError("invalid_request", "body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BillError(
      "invalid_request",
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

const toDate = (v: number | string) => new Date(typeof v === "number" ? v : Date.parse(v));

export function createApp(db: Db) {
  const app = new Hono<Vars>();

  app.onError((err, c) => {
    if (err instanceof BillError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: `no route for ${c.req.method} ${c.req.path}` } }, 404));

  app.get("/health", (c) => c.json({ ok: true }));

  const v1 = new Hono<Vars>();
  v1.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const scope = key ? await resolveApiKey(db, key) : null;
    if (!scope) throw new BillError("unauthorized", "missing or invalid API key");
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
    return c.json(await attach(db, c.get("scope"), b));
  });

  v1.get("/customers/:id", async (c) => c.json(await getCustomer(db, c.get("scope"), c.req.param("id"))));
  v1.put("/customers/:id", async (c) => {
    const b = await body(c, schemas.customer);
    return c.json(await upsertCustomer(db, c.get("scope"), { id: c.req.param("id"), ...b }));
  });
  v1.get("/customers/:id/invoices", async (c) => {
    const customer = await getCustomer(db, c.get("scope"), c.req.param("id"));
    return c.json({ invoices: customer.invoices });
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
      throw new BillError("invalid_request", "body must be JSON");
    });
    const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
    return c.json(await applyConfig(db, c.get("scope"), raw, { dryRun }));
  });

  // Planned for later milestones (doc 05). Explicit, so clients get a clear answer.
  for (const [method, path, milestone] of [
    ["post", "/preview", "M3"],
    ["post", "/topups", "M3"],
    ["post", "/portal", "M3"],
    ["get", "/verify", "M2"],
  ] as const) {
    v1[method](path, () => {
      throw new BillError("not_implemented", `${path} arrives in milestone ${milestone}`);
    });
  }

  app.route("/v1", v1);
  return app;
}
