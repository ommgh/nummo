/**
 * Demo: an AI chat app that charges in credits (doc 04, "What the demo app shows").
 *
 * The model is faked; the billing is real. Every message is gated with
 * `check({ sendEvent: true })`, so it is allowed and charged in one call.
 * "Upgrade" sends the user to nummo's hosted checkout, where a Solana wallet
 * signs once. "Buy credits" is a one-off top-up, "Billing" opens the hosted
 * customer portal (plan changes, receipts, cancel). Set DEMO_SKIP_PAYMENT=1 to
 * upgrade without a wallet (test only).
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Nummo, NummoApiError } from "@usenummo/sdk";

const nummo = new Nummo();
const app = new Hono();

app.get("/", (c) => c.html(PAGE));

app.post("/api/chat", async (c) => {
  const { userId, message, premium } = await c.req.json<{ userId: string; message: string; premium: boolean }>();
  const featureId = premium ? "premium_message" : "basic_message";
  const gate = await nummo.check({ customerId: userId, featureId, sendEvent: true, properties: { chars: message.length } });
  if (!gate.allowed) {
    return c.json({ allowed: false, reply: null, reason: "Out of credits. Upgrade to Pro for 1,000 credits every 30 days." }, 402);
  }
  const reply = premium ? `(premium model) You said ${message.length} characters. Thoughtful!` : `(basic model) Echo: ${message}`;
  return c.json({ allowed: true, reply, failedOpen: gate.failedOpen ?? false });
});

app.get("/api/me/:userId", async (c) => {
  try {
    return c.json(await nummo.customers.get(c.req.param("userId")));
  } catch {
    return c.json({ balances: [], subscriptions: [] });
  }
});

app.post("/api/upgrade", async (c) => {
  const { userId } = await c.req.json<{ userId: string }>();
  const skipPayment = process.env.DEMO_SKIP_PAYMENT === "1";
  try {
    const successUrl = new URL("/?upgraded=1", c.req.url).toString();
    return c.json(await nummo.attach({ customerId: userId, planId: "pro", successUrl, skipPayment }));
  } catch (e) {
    if (e instanceof NummoApiError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.post("/api/topup", async (c) => {
  const { userId } = await c.req.json<{ userId: string }>();
  try {
    const successUrl = new URL("/?topped=1", c.req.url).toString();
    return c.json(await nummo.topUp({ customerId: userId, featureId: "credits", amount: 5_000_000n, successUrl }));
  } catch (e) {
    if (e instanceof NummoApiError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.post("/api/billing", async (c) => {
  const { userId } = await c.req.json<{ userId: string }>();
  // In a real app: only for the signed-in user, and a fresh link each time.
  return c.json(await nummo.portal({ customerId: userId, returnUrl: new URL("/", c.req.url).toString() }));
});

const port = Number(process.env.DEMO_PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`demo chat on http://localhost:${port}`));

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nummo demo chat</title>
<style>
  :root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --accent:#7c3aed; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#1c1917; --fg:#f5f5f4; --muted:#a8a29e; --line:#44403c; --accent:#a78bfa; --bad:#f87171; } }
  * { box-sizing: border-box; } body { margin:0; font:15px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px; }
  header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .meter { font-variant-numeric: tabular-nums; color: var(--muted); }
  #log { border:1px solid var(--line); border-radius:8px; padding:12px; min-height:240px; margin:16px 0; overflow-wrap:anywhere; }
  .me { color: var(--muted); } .bad { color: var(--bad); }
  form { display:flex; gap:8px; flex-wrap:wrap; } input[type=text] { flex:1; min-width:160px; padding:8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; }
  button { padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:white; cursor:pointer; }
  button.ghost { background:transparent; color:var(--accent); }
</style></head>
<body><main>
  <header><h1>Demo chat</h1><span class="meter" id="meter">loading…</span></header>
  <p class="meter">Basic message = 1 credit. Premium message = 10 credits. Free plan: 100 credits every 30 days.</p>
  <div id="log"></div>
  <form id="f">
    <input type="text" id="msg" placeholder="Say something" required>
    <label><input type="checkbox" id="premium"> premium</label>
    <button>Send</button>
    <button type="button" class="ghost" id="up">Upgrade to Pro</button>
    <button type="button" class="ghost" id="buy">Buy 500 credits (5 USDC)</button>
    <button type="button" class="ghost" id="billing">Billing</button>
  </form>
</main>
<script>
  const userId = localStorage.getItem("demoUser") || "user_" + Math.random().toString(36).slice(2, 8);
  try { localStorage.setItem("demoUser", userId); } catch {}
  const log = document.getElementById("log");
  const add = (cls, text) => { const p = document.createElement("p"); p.className = cls; p.textContent = text; log.append(p); };
  async function refresh() {
    const me = await (await fetch("/api/me/" + userId)).json();
    const credits = (me.balances || []).find(b => b.featureId === "credits");
    const plan = (me.subscriptions || []).find(s => s.status !== "ended");
    document.getElementById("meter").textContent =
      (plan ? plan.planName : "Free") + " · " + (credits ? credits.balance + " / " + credits.granted : "100 / 100") + " credits";
  }
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const message = document.getElementById("msg").value;
    add("me", userId + ": " + message);
    const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, message, premium: document.getElementById("premium").checked }) });
    const j = await r.json();
    j.allowed ? add("", j.reply) : add("bad", j.reason);
    document.getElementById("msg").value = "";
    refresh();
  };
  document.getElementById("up").onclick = async () => {
    const r = await fetch("/api/upgrade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
    const j = await r.json();
    if (j.checkoutUrl) { location.assign(j.checkoutUrl); return; }
    j.error ? add("bad", j.error) : add("", "Upgraded to Pro.");
    refresh();
  };
  const go = async (path) => {
    const j = await (await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) })).json();
    if (j.checkoutUrl || j.url) location.assign(j.checkoutUrl || j.url); else add("bad", j.error || "Something went wrong.");
  };
  document.getElementById("buy").onclick = () => go("/api/topup");
  document.getElementById("billing").onclick = () => go("/api/billing");
  if (new URLSearchParams(location.search).has("topped")) add("", "500 credits added. Purchased credits do not expire.");
  if (new URLSearchParams(location.search).has("upgraded")) add("", "Welcome to Pro. Your wallet signed once; renewals are collected automatically.");
  refresh();
</script></body></html>`;
