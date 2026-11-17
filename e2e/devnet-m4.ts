// Milestone M4 on Solana devnet (doc 05): an agent pays the demo per request.
//
//   node e2e/devnet-m4.ts
//
// - the real demo server (apps/demo) runs against an in-process API with agent payments on
// - the agent script (apps/demo/src/agent.ts) pays for /agent/chat twice over x402 and twice over MPP,
//   from a wallet holding devnet USDC and no SOL; the puller pays the network fees
// - each payment lands in the merchant's USDC account and in nummo as an invoice, a payment
//   and a usage event under the customer `wallet:<agent>`, next to subscribers in the dashboard
// - a replayed x402 payment is not served or recorded twice
// - a signed-in user with credits is served from them, with no 402
// - per-model token pricing charges credits at the model's rates
//
// Needs: e2e/.keys/agent.json holding devnet USDC (https://faucet.circle.com, Solana Devnet),
// and the puller in e2e/.keys/puller.json with a little devnet SOL. Unlike the M2 and M3 runs this
// uses real devnet USDC, because x402 and MPP clients only pay in known stablecoins.

import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { readFileSync } from "node:fs";
import { agentPaymentsFromEnv } from "@usenummo/agents";
import { createApp } from "@usenummo/api";
import { toDocument, usdc } from "@usenummo/config";
import { createApiKey, createDb, createOrg, ensureDatabase, overview, runMigrations, schema } from "@usenummo/db";
import { Nummo, type PaywallGranted } from "@usenummo/sdk";
import { settingsFromEnv } from "@usenummo/settlement";
import { and, eq } from "drizzle-orm";
import demoConfig from "../apps/demo/nummo.config.ts";
import { check, DATABASE_URL, KEYS, log, result, ROOT, RPC_URL, sleep, sol, tokenBalance } from "./lib.ts";

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const started = Date.now();

const keyAddress = async (file: string) => (await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))))).address;
const agent = await keyAddress(`${KEYS}/agent.json`);
const merchant = await keyAddress(`${KEYS}/merchant.json`);
const puller = await keyAddress(`${KEYS}/puller.json`);
const agentUsdc = await tokenBalance(USDC_DEVNET, agent);
log(`agent    ${agent}: ${Number(agentUsdc) / 1e6} USDC, ${Number(await sol(agent)) / 1e9} SOL`);
log(`merchant ${merchant}`);
log(`puller   ${puller}: ${Number(await sol(puller)) / 1e9} SOL`);
if (agentUsdc < 100_000n) throw new Error("the agent needs at least 0.1 devnet USDC: https://faucet.circle.com (Solana Devnet)");

// ---------------------------------------------------------------- API with agent payments on

await ensureDatabase(DATABASE_URL);
const { db, close } = createDb(DATABASE_URL);
await runMigrations(db);
const env = { NUMMO_TEST_PULLER_KEY: `${KEYS}/puller.json`, NUMMO_TEST_RPC_URL: RPC_URL };
const agents = await agentPaymentsFromEnv(db, env);
const settings = settingsFromEnv({});
const api = serve({ fetch: createApp(db, { settings, agents }).fetch, port: 0 });
await new Promise((r) => api.once("listening", r));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

const orgId = await createOrg(db, "devnet m4");
const scope = { orgId, env: "test" as const };
const apiKey = (await createApiKey(db, orgId, "test")).key;
const nummo = new Nummo({ secretKey: apiKey, baseUrl: apiUrl });
await nummo.config.push(toDocument({ ...demoConfig, payTo: merchant }));
log(`org ${orgId}; demo pricing applied with payTo ${merchant}`);

// ---------------------------------------------------------------- the real demo server

const demoPort = 3400 + Math.floor(Math.random() * 500);
const demoUrl = `http://127.0.0.1:${demoPort}`;
const demo = spawn(process.execPath, [`${ROOT}apps/demo/src/server.ts`], {
  cwd: `${ROOT}apps/demo`,
  env: { ...process.env, NUMMO_SECRET_KEY: apiKey, NUMMO_API_URL: apiUrl, DEMO_PORT: String(demoPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
demo.stderr.on("data", (d) => process.stderr.write(`    demo! ${d}`));
for (let i = 0; i < 50; i++) {
  if (await fetch(demoUrl).then((r) => r.ok).catch(() => false)) break;
  await sleep(200);
}

function runAgent(url: string, calls: number, protocol?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [`${ROOT}apps/demo/src/agent.ts`, `${KEYS}/agent.json`, String(calls), ...(protocol ? [protocol] : [])], {
      cwd: `${ROOT}apps/demo`,
      env: { ...process.env, DEMO_URL: url, AGENT_RPC_URL: RPC_URL },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      for (const line of out.trim().split("\n")) console.log(`    | ${line}`);
      resolve({ code: code ?? 1, out });
    });
  });
}

// ---------------------------------------------------------------- 1. unpaid request

log("1. an unpaid request is answered with a 402 offering x402 and MPP");
const unpaid = await fetch(`${demoUrl}/agent/chat`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
const offer = (await unpaid.json()) as { accepts?: { protocol: string; scheme: string; amount: string; payTo: string }[] };
check(unpaid.status === 402, `status 402 (got ${unpaid.status})`);
check(!!unpaid.headers.get("payment-required"), "x402 PAYMENT-REQUIRED header present");
check(/^Payment /.test(unpaid.headers.get("www-authenticate") ?? ""), "MPP WWW-Authenticate: Payment challenge present");
check(
  offer.accepts?.some((a) => a.protocol === "x402" && a.scheme === "exact" && a.amount === "10000" && a.payTo === merchant) ?? false,
  "x402 exact offer: 10000 base units (0.01 USDC) to the merchant",
);
check(offer.accepts?.some((a) => a.protocol === "mpp" && a.scheme === "charge") ?? false, "MPP charge offer");

// ---------------------------------------------------------------- 2. the agent pays

log("2. the agent script pays for four calls: x402, MPP, x402, MPP");
const merchantBefore = await tokenBalance(USDC_DEVNET, merchant);
const pullerSolBefore = await sol(puller);
const run = await runAgent(demoUrl, 4);
check(run.code === 0, "agent script exited 0");
check((run.out.match(/ 200 in /g) ?? []).length === 4, "four 200 responses");
check((run.out.match(/receipt /g) ?? []).length === 4, "each response carried a payment receipt header");
await sleep(2_000);
const merchantAfter = await tokenBalance(USDC_DEVNET, merchant);
check(merchantAfter - merchantBefore === 40_000n, `merchant received 0.04 USDC (got ${Number(merchantAfter - merchantBefore) / 1e6})`);
check((await sol(agent)) === 0n, "the agent still holds no SOL: the puller paid the fees");
const feeSpent = pullerSolBefore - (await sol(puller));
log(`   puller spent ${Number(feeSpent) / 1e9} SOL on four payments`);

const walletCustomer = `wallet:${agent}`;
const inv = (await nummo.customers.invoices(walletCustomer)).invoices;
check(inv.length === 4 && inv.every((i) => i.kind === "pay_per_use" && i.status === "paid" && i.total === "0.01"), "four paid pay_per_use invoices of 0.01 under the wallet customer");
const ofAgent = and(eq(schema.payments.orgId, orgId), eq(schema.payments.customerId, walletCustomer));
const pays = await db.select().from(schema.payments).where(ofAgent);
const protocols = pays.map((p) => p.protocol).sort();
check(protocols.join(",") === "mpp,mpp,x402,x402", `payments by protocol: ${protocols.join(", ")}`);
check(pays.every((p) => p.wallet === agent), "each payment records the paying wallet");
const statuses = (await fetch(RPC_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [pays.map((p) => p.signature), { searchTransactionHistory: true }] }),
}).then((r) => r.json())) as { result: { value: ({ err: unknown } | null)[] } };
check(statuses.result.value.every((v) => v !== null && v.err === null), "every recorded signature is a successful transaction on devnet");
for (const p of pays) log(`   ${p.protocol} ${p.signature}`);
const cust = await nummo.customers.get(walletCustomer);
check(cust.subscriptions.length === 0 && (cust.name ?? "").startsWith("Agent "), `customer ${cust.name}: no plan, pays per request`);

// ---------------------------------------------------------------- 3. replay

log("3. a replayed payment, x402 or MPP, is not served or recorded twice");
const captured: Record<string, string>[] = [];
const capture = new Hono<{ Variables: { nummo: PaywallGranted } }>();
const gate = nummo.paywall({ featureId: "premium_message" });
capture.post("/agent/chat", async (c, next) => {
  const h: Record<string, string> = {};
  for (const k of ["payment-signature", "authorization", "content-type"]) {
    const v = c.req.header(k);
    if (v) h[k] = v;
  }
  if (h["payment-signature"] || h.authorization) captured.push(h);
  await next();
}, gate.hono(), (c) => c.json({ ok: true, paid: c.get("nummo").paid }));
const capServer = serve({ fetch: capture.fetch, port: 0 });
await new Promise((r) => capServer.once("listening", r));
const capUrl = `http://127.0.0.1:${(capServer.address() as AddressInfo).port}`;
for (const protocol of ["x402", "mpp"] as const) {
  const before = captured.length;
  const one = await runAgent(capUrl, 1, protocol);
  const credential = captured.at(-1)!;
  const kind = credential["payment-signature"] ? "x402" : /^Payment /.test(credential.authorization ?? "") ? "mpp" : "none";
  check(one.code === 0 && captured.length === before + 1 && kind === protocol, `one more ${protocol} payment, its credential captured`);
  const replay = await fetch(`${capUrl}/agent/chat`, { method: "POST", headers: credential, body: "{}" });
  const replayBody = await replay.text();
  check(replay.status !== 200, `${protocol} replay refused (status ${replay.status}: ${replayBody.slice(0, 80)})`);
}
const after = await db.select().from(schema.payments).where(ofAgent);
check(after.length === 6, `six payments recorded, not eight (got ${after.length})`);
await new Promise((r) => capServer.close(r));

// ---------------------------------------------------------------- 4. subscribers next to agents

log("4. a signed-in user with credits is served from them; tokens are charged per model");
const member = await fetch(`${demoUrl}/agent/chat`, { method: "POST", headers: { "x-user": "member_1", "content-type": "application/json" }, body: "{}" });
const memberBody = (await member.json()) as { paid?: boolean; customerId?: string };
check(member.status === 200 && memberBody.paid === false && memberBody.customerId === "member_1", "member_1 served from the free plan's credits, no payment");
const complete = await fetch(`${demoUrl}/api/complete`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId: "member_1", model: "claude-sonnet-5-5", prompt: "how much does a token cost when it is billed through nummo" }),
});
const cBody = (await complete.json()) as { allowed: boolean; usage: { input: number; output: number }; credits: number };
// Sonnet: 3 USDC / 1M input * 1.2 / 0.01 = 0.00036 credits per input token; 15 USDC output -> 0.0018.
const expected = cBody.usage.input * 0.00036 + cBody.usage.output * 0.0018;
check(complete.ok && Math.abs(cBody.credits - expected) < 1e-9, `model call charged ${cBody.credits} credits for ${cBody.usage.input} in / ${cBody.usage.output} out`);

const o = await overview(db, scope);
check(o.agentPayments30d.count === 6 && o.agentPayments30d.wallets === 1, `dashboard overview: ${o.agentPayments30d.count} agent payments from ${o.agentPayments30d.wallets} wallet, ${o.collected30d} USDC collected`);
const list = await nummo.customers.list();
check(list.customers.some((c) => c.id === walletCustomer) && list.customers.some((c) => c.id === "member_1"), "the agent and the member are in the same customer list");

demo.kill();
await new Promise((r) => api.close(r));
await close();
log(`done in ${Math.round((Date.now() - started) / 1000)} s, ${result.failures} failure(s)`);
process.exit(result.failures ? 1 : 0);
