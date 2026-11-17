import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { toDocument } from "@usenummo/config";
import { createApiKey, createDb, createOrg, runMigrations } from "@usenummo/db";
import { Nummo, NummoApiError } from "@usenummo/sdk";
import { createApp } from "../src/app.ts";
import { exampleConfig } from "../../../packages/db/test/helpers.ts";

const { db, close } = createDb();
let server: ServerType;
let baseUrl: string;
let key: string;

beforeAll(async () => {
  await runMigrations(db);
  const orgId = await createOrg(db, "api test");
  key = (await createApiKey(db, orgId, "test")).key;
  server = serve({ fetch: createApp(db).fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await close();
});

describe("API through the SDK", () => {
  test("rejects a bad key with the standard error body", async () => {
    const res = await fetch(`${baseUrl}/v1/check`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "missing or invalid API key" } });
  });

  test("config push, check, track, lock and finalize", async () => {
    const nummo = new Nummo({ secretKey: key, baseUrl });
    const dry = await nummo.config.push(toDocument(exampleConfig), { dryRun: true });
    expect(dry.dryRun).toBe(true);
    const applied = await nummo.config.push(toDocument(exampleConfig));
    expect(applied.changes.filter((c) => c.action === "create").map((c) => c.id)).toContain("pro@1");

    const c = await nummo.check({ customerId: "user_123", featureId: "premium_message", requiredBalance: 1 });
    expect(c).toMatchObject({ allowed: true, available: "10" });

    const t = await nummo.track({ customerId: "user_123", featureId: "premium_message", value: 1, idempotencyKey: "r1", properties: { model: "claude-fable-5-2" } });
    expect(t?.deducted).toEqual([{ featureId: "credits", amount: "10" }]);

    const lockId = "completion_1";
    const locked = await nummo.check({ customerId: "user_123", featureId: "basic_message", requiredBalance: 40, lock: { lockId, expiresAt: Date.now() + 60_000 } });
    expect(locked.lock?.lockId).toBe(lockId);
    const fin = await nummo.balances.finalize({ lockId, action: "confirm", overrideValue: 25 });
    expect(fin.event?.value).toBe("25");

    const customer = await nummo.customers.get("user_123");
    expect(customer.subscriptions[0]).toMatchObject({ planId: "free", status: "active" });
    expect(customer.balances[0]).toMatchObject({ featureId: "credits", balance: "65" });

    await expect(nummo.attach({ customerId: "user_123", planId: "pro" })).rejects.toMatchObject({ code: "plan_not_published", status: 409 });
  });

  test("validation errors are 400 invalid_request", async () => {
    const nummo = new Nummo({ secretKey: key, baseUrl });
    const err = await nummo.track({ customerId: "u", featureId: "basic_message", value: "-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(NummoApiError);
    expect(err.code).toBe("invalid_request");
    await expect(nummo.check({ customerId: "u", featureId: "nope" })).rejects.toMatchObject({ code: "feature_not_found" });
  });

  test("fails open when the API is down, then resends queued usage exactly once", async () => {
    let down = true;
    const flaky: typeof fetch = (input, init) => (down ? Promise.reject(new TypeError("connect ECONNREFUSED")) : fetch(input, init));
    const nummo = new Nummo({ secretKey: key, baseUrl, fetch: flaky, failClosed: ["premium_message"] });

    expect(await nummo.check({ customerId: "offline", featureId: "basic_message" })).toMatchObject({ allowed: true, failedOpen: true });
    expect((await nummo.check({ customerId: "offline", featureId: "premium_message" })).allowed).toBe(false);
    expect(await nummo.track({ customerId: "offline", featureId: "basic_message", value: 3 })).toBeNull();
    expect(nummo.pending).toBe(1);

    down = false;
    await nummo.flush();
    await nummo.flush(); // a second flush must not double count
    expect(nummo.pending).toBe(0);
    const c = await nummo.customers.get("offline");
    expect(c.balances[0]!.balance).toBe("97");
  });
});

describe("settlement routes", () => {
  test("publish, checkout through the public routes, verify, webhook endpoint", async () => {
    const { FakeChain } = await import("@usenummo/solana/testing");
    const { planIdSeed } = await import("@usenummo/settlement");
    const chain = new FakeChain({ now: new Date() });
    const orgId = await createOrg(db, "api settlement test");
    const k = (await createApiKey(db, orgId, "test")).key;
    const srv = serve({ fetch: createApp(db, { chains: { test: chain } }).fetch, port: 0 });
    await new Promise((r) => srv.once("listening", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const nummo = new Nummo({ secretKey: k, baseUrl: url });
      await nummo.config.push(toDocument(exampleConfig));
      const plans = await nummo.plans.list();
      const pro = plans.versions.find((v) => v.planId === "pro")!;
      expect(plans.settlement?.puller).toBe(chain.pullerAddress);
      expect(pro.onchainTerms).toMatchObject({ ceiling: "70", periodHours: 720 });

      // A plan with the wrong ceiling is refused; the right one is accepted.
      const wrong = chain.createPlan({ owner: "m", planId: 1n, amount: 1n, periodHours: 720 });
      await expect(nummo.plans.publish("pro", 1, wrong.address.padEnd(32, "x"))).rejects.toMatchObject({ code: "invalid_request" });
      const right = chain.createPlan({ owner: "merchant_wallet_for_api_test", planId: planIdSeed({ orgId, env: "test" }, "pro", 1), amount: 70_000_000n, periodHours: 720 });
      await nummo.plans.publish("pro", 1, right.address);

      const a = await nummo.attach({ customerId: "buyer", planId: "pro", successUrl: "https://shop.example/ok" });
      expect(a.status).toBe("pending");
      const path = new URL(a.checkoutUrl!).pathname;
      expect((await fetch(`${url}${path}`)).headers.get("content-type")).toContain("text/html");
      const session = await (await fetch(`${url}${path}/session`)).json();
      expect(session).toMatchObject({ status: "open", firstCharge: "20", onchain: { ceiling: "70", period: "every 30 days" } });

      const wallet = chain.wallet(100_000_000n);
      const post = (p: string, b: unknown) => fetch(`${url}${path}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      const { transaction } = await (await post("/transaction", { wallet })).json();
      const done = await (await post("/submit", { signedTransaction: chain.walletSign(transaction, wallet) })).json();
      expect(done).toMatchObject({ status: "completed", successUrl: "https://shop.example/ok" });

      const c = await nummo.customers.get("buyer");
      expect(c.subscriptions.find((s) => s.status === "active")).toMatchObject({ planId: "pro", wallet });
      expect((await nummo.customers.invoices("buyer")).invoices[0]).toMatchObject({ kind: "activation", status: "paid", total: "20" });
      expect(await nummo.verify()).toMatchObject({ ok: true, network: "fake" });

      const { endpoint } = await nummo.webhooks.set("https://shop.example/hooks");
      expect(endpoint.secret).toMatch(/^whsec_/);
      expect((await nummo.webhooks.get()).endpoint?.url).toBe("https://shop.example/hooks");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  test("without a chain, settlement routes say so instead of failing open", async () => {
    const nummo = new Nummo({ secretKey: key, baseUrl });
    await expect(nummo.verify()).rejects.toMatchObject({ code: "settlement_unavailable", status: 503 });
  });
});
