/**
 * Demo: an AI chat app that charges in credits (doc 04, "What the demo app shows").
 *
 * The model is faked; the billing is real. Every message is gated with
 * `check({ sendEvent: true })`, so it is allowed and charged in one call.
 * Steps 1 to 3 of the demo script work in M1; the wallet upgrade arrives in M2,
 * so "Upgrade" uses the test environment's skipPayment for now.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Bill } from "@bill/sdk";

const bill = new Bill();
const app = new Hono();

app.get("/", (c) => c.html(PAGE));

app.post("/api/chat", async (c) => {
  const { userId, message, premium } = await c.req.json<{ userId: string; message: string; premium: boolean }>();
  const featureId = premium ? "premium_message" : "basic_message";
  const gate = await bill.check({ customerId: userId, featureId, sendEvent: true, properties: { chars: message.length } });
  if (!gate.allowed) {
    return c.json({ allowed: false, reply: null, reason: "Out of credits. Upgrade to Pro for 1,000 credits every 30 days." }, 402);
  }
  const reply = premium ? `(premium model) You said ${message.length} characters. Thoughtful!` : `(basic model) Echo: ${message}`;
  return c.json({ allowed: true, reply, failedOpen: gate.failedOpen ?? false });
});

app.get("/api/me/:userId", async (c) => {
  try {
    return c.json(await bill.customers.get(c.req.param("userId")));
  } catch {
    return c.json({ balances: [], subscriptions: [] });
  }
});

app.post("/api/upgrade", async (c) => {
  const { userId } = await c.req.json<{ userId: string }>();
  // M2 replaces skipPayment with a checkout URL where the wallet signs once.
  return c.json(await bill.attach({ customerId: userId, planId: "pro", skipPayment: true }));
});

const port = Number(process.env.DEMO_PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`demo chat on http://localhost:${port}`));

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bill demo chat</title>
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
    await fetch("/api/upgrade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) });
    add("", "Upgraded to Pro (test mode, no payment yet).");
    refresh();
  };
  refresh();
</script></body></html>`;
