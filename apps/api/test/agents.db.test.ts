/**
 * Milestone M4 through the HTTP API and the SDK: pay per use over a stand-in
 * payment gate (the real one is Solana's pay-kit, exercised on devnet by
 * e2e/devnet-m4.ts), and per-model token pricing.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { toDocument, usdc } from "@usenummo/config";
import { AgentPayments, type PaymentGate } from "@usenummo/agents";
import { createApiKey, createDb, createOrg, getCustomer, runMigrations } from "@usenummo/db";
import { Nummo, type PaywallGranted } from "@usenummo/sdk";
import { createApp } from "../src/app.ts";
import { exampleConfig } from "../../../packages/db/test/helpers.ts";

const MERCHANT = "HspFJvU6QLVsKYsejHc3ccVSS8iXcKK51FobSmLBbKc4";
// Signatures are unique across the whole database, which keeps rows between runs.
const run = Math.random().toString(36).slice(2, 8);
const SIG_1 = `sig_1_${run}`;
const SIG_BOB = `sig_bob_${run}`;
const AGENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

/**
 * Stands in for pay-kit: an unpaid request gets a 402 naming the price; a
 * request with `payment-signature: sig_<n>` is "settled" with that signature,
 * paid by AGENT. Records what it was asked to charge.
 */
function fakeGate() {
  const charged: { amount: string; payTo: string; url: string }[] = [];
  const gate: PaymentGate = {
    requirePayment: (async (request: Request, resolver: unknown) => {
      const params = (resolver as () => { amount: { amount: string }; payTo: string })();
      const sig = request.headers.get("payment-signature");
      if (!sig) {
        const body = JSON.stringify({ accepts: [{ protocol: "x402", scheme: "exact", amount: params.amount.amount, payTo: params.payTo }] });
        return {
          status: 402,
          challenge: { accepts: [], headers: {}, resource: new URL(request.url).pathname },
          response: new Response(body, { status: 402, headers: { "payment-required": "challenge", "content-type": "application/json" } }),
        };
      }
      charged.push({ amount: params.amount.amount, payTo: params.payTo, url: request.url });
      return {
        status: 200,
        charge: undefined,
        payment: { gateName: undefined, payer: AGENT, protocol: "x402", raw: sig, scheme: "exact", settlementHeaders: { "payment-response": `ok:${sig}` }, transaction: sig },
        settle: async () => ({ "payment-response": `ok:${sig}` }),
        withSettlement: async (r: Response) => r,
      };
    }) as PaymentGate["requirePayment"],
  };
  return { gate, charged };
}

const { db, close } = createDb();
const fake = fakeGate();
let server: ServerType;
let app: ServerType;
let baseUrl: string;
let appUrl: string;
let nummo: Nummo;
let orgId: string;

const config = {
  ...exampleConfig,
  payTo: MERCHANT,
  payPerUse: [{ feature: "premium_message", price: usdc("0.01") }],
  models: {
    creditSystem: "credits",
    creditPrice: usdc("0.01"),
    markup: "20%",
    prices: { "claude-opus-5-5": { input: usdc("5"), output: usdc("25") } },
  },
};

beforeAll(async () => {
  await runMigrations(db);
  orgId = await createOrg(db, "agents test");
  const key = (await createApiKey(db, orgId, "test")).key;
  server = serve({ fetch: createApp(db, { agents: new AgentPayments(db, { test: fake.gate }) }).fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  nummo = new Nummo({ secretKey: key, baseUrl });
  await nummo.config.push(toDocument(config));

  // The merchant's app: a Hono route behind the paywall. Signed-in users send x-user.
  const demo = new Hono<{ Variables: { nummo: PaywallGranted } }>();
  const gate = nummo.paywall({ featureId: "premium_message", identify: (req) => req.headers.get("x-user") ?? undefined });
  demo.post("/agent/chat", gate.hono(), (c) => c.json({ reply: "hello", customerId: c.get("nummo").customerId, paid: c.get("nummo").paid }));
  app = serve({ fetch: demo.fetch, port: 0 });
  await new Promise((r) => app.once("listening", r));
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => app.close(r));
  await close();
});

describe("pay per use (x402 / MPP)", () => {
  test("an anonymous agent gets a 402, pays, is served, and becomes a wallet customer", async () => {
    const first = await fetch(`${appUrl}/agent/chat`, { method: "POST" });
    expect(first.status).toBe(402);
    expect(first.headers.get("payment-required")).toBe("challenge");
    expect((await first.json()).accepts[0]).toMatchObject({ amount: "0.01", payTo: MERCHANT });

    const paid = await fetch(`${appUrl}/agent/chat`, { method: "POST", headers: { "payment-signature": SIG_1, authorization: "Bearer app-secret" } });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBe(`ok:${SIG_1}`);
    expect(await paid.json()).toEqual({ reply: "hello", customerId: `wallet:${AGENT}`, paid: true });
    expect(fake.charged.at(-1)).toMatchObject({ amount: "0.01", payTo: MERCHANT });

    const customer = await getCustomer(db, { orgId, env: "test" }, `wallet:${AGENT}`);
    expect(customer.name).toBe("Agent 7xKX…gAsU");
    // A wallet customer is not put on the free plan.
    expect(customer.subscriptions).toEqual([]);
    const inv = (await nummo.customers.invoices(`wallet:${AGENT}`)).invoices;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ kind: "pay_per_use", status: "paid", total: "0.01" });
    expect(inv[0]!.payments[0]).toMatchObject({ signature: SIG_1, amount: "0.01" });
  });

  test("the same payment is recorded once", async () => {
    const again = await nummo.pay({ request: { method: "POST", url: `${appUrl}/agent/chat`, headers: { "payment-signature": SIG_1 } }, featureId: "premium_message" });
    expect(again.status).toBe("paid");
    if (again.status === "paid") expect(again.event?.replayed).toBe(true);
    expect((await nummo.customers.invoices(`wallet:${AGENT}`)).invoices).toHaveLength(1);
  });

  test("a signed-in customer with credits is served from the balance, with no 402", async () => {
    const res = await fetch(`${appUrl}/agent/chat`, { method: "POST", headers: { "x-user": "alice" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "hello", customerId: "alice", paid: false });
    const alice = await nummo.customers.get("alice");
    expect(alice.balances.find((b) => b.featureId === "credits")?.balance).toBe("90");
  });

  test("a signed-in customer out of credits can pay per request, and it is recorded against them", async () => {
    for (let i = 0; i < 10; i++) await fetch(`${appUrl}/agent/chat`, { method: "POST", headers: { "x-user": "bob" } });
    const broke = await fetch(`${appUrl}/agent/chat`, { method: "POST", headers: { "x-user": "bob" } });
    expect(broke.status).toBe(402);
    const paid = await fetch(`${appUrl}/agent/chat`, { method: "POST", headers: { "x-user": "bob", "payment-signature": SIG_BOB } });
    expect(await paid.json()).toEqual({ reply: "hello", customerId: "bob", paid: true });
    const inv = (await nummo.customers.invoices("bob")).invoices;
    expect(inv.map((i) => i.kind)).toEqual(["pay_per_use"]);
    const bob = await getCustomer(db, { orgId, env: "test" }, "bob");
    expect(bob.subscriptions[0]).toMatchObject({ planId: "free" });
  });

  test("a value above 1 is priced per unit; a feature without a price is refused", async () => {
    const r = await nummo.pay({ request: { method: "GET", url: `${appUrl}/x`, headers: {} }, featureId: "premium_message", value: 3 });
    expect(r).toMatchObject({ status: "payment_required", price: { amount: "0.03", value: "3" } });
    await expect(nummo.pay({ request: { method: "GET", url: `${appUrl}/x`, headers: {} }, featureId: "basic_message" })).rejects.toMatchObject({
      code: "pay_per_use_not_available",
    });
  });

  test("the app's own bearer token never reaches nummo", async () => {
    let seen: Record<string, string> = {};
    const spy = new Nummo({
      secretKey: "k",
      baseUrl,
      fetch: async (_url, init) => {
        seen = JSON.parse(String(init?.body)).request.headers;
        return new Response(JSON.stringify({ status: "allowed", customerId: "x", event: null, headers: {} }));
      },
    });
    await spy.paywall({ featureId: "premium_message" }).check(new Request("http://app/x", { headers: { authorization: "Bearer secret", accept: "application/json" } }));
    expect(seen).toEqual({ accept: "application/json" });
    await spy.paywall({ featureId: "premium_message" }).check(new Request("http://app/x", { headers: { authorization: "Payment abc" } }));
    expect(seen).toEqual({ authorization: "Payment abc" });
  });

  test("without the API, a signed-in customer fails open and an agent gets a 503", async () => {
    const down = new Nummo({ secretKey: "k", baseUrl, fetch: () => Promise.reject(new TypeError("ECONNREFUSED")) });
    const gate = down.paywall({ featureId: "premium_message", identify: (r) => r.headers.get("x-user") });
    expect(await gate.check(new Request("http://app/x", { headers: { "x-user": "alice" } }))).toMatchObject({ ok: true, failedOpen: true });
    const anon = await gate.check(new Request("http://app/x"));
    expect(anon.ok).toBe(false);
    if (!anon.ok) expect(anon.response.status).toBe(503);
  });
});

describe("per-model token pricing", () => {
  test("tokens are charged in credits at the model's rates", async () => {
    // 1,000 input tokens at 0.0006 credits + 200 output at 0.003 = 0.6 + 0.6 = 1.2 credits.
    const r = await nummo.trackTokens({ customerId: "carol", model: "claude-opus-5-5", usage: { input: 1000, output: 200 }, idempotencyKey: "call_1" });
    expect(r.events.map((e) => [e.kind, e.featureId, e.deducted])).toEqual([
      ["input", "claude_opus_5_5_input", [{ featureId: "credits", amount: "0.6" }]],
      ["output", "claude_opus_5_5_output", [{ featureId: "credits", amount: "0.6" }]],
    ]);
    const again = await nummo.trackTokens({ customerId: "carol", model: "claude-opus-5-5", usage: { input: 1000, output: 200 }, idempotencyKey: "call_1" });
    expect(again.events.every((e) => e.replayed)).toBe(true);
    const carol = await nummo.customers.get("carol");
    expect(carol.balances.find((b) => b.featureId === "credits")?.balance).toBe("98.8");
  });

  test("checkTokens converts the whole call to one requirement", async () => {
    // 98.8 credits left. 100,000 input (60 credits) + 20,000 output (60 credits) = 120 > 98.8.
    const no = await nummo.checkTokens({ customerId: "carol", model: "claude-opus-5-5", usage: { input: 100_000, output: 20_000 } });
    expect(no.allowed).toBe(false);
    const yes = await nummo.checkTokens({ customerId: "carol", model: "claude-opus-5-5", usage: { input: 50_000, output: 10_000 } });
    expect(yes).toMatchObject({ allowed: true, featureId: "claude_opus_5_5_output", requiredBalance: "20000" });
  });

  test("an unknown model or token kind is an error", async () => {
    await expect(nummo.trackTokens({ customerId: "carol", model: "gpt-9", usage: { input: 1 } })).rejects.toMatchObject({ code: "model_not_found", status: 404 });
    await expect(nummo.trackTokens({ customerId: "carol", model: "claude-opus-5-5", usage: { cachedInput: 5 } })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
