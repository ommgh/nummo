/**
 * The merchant dashboard (doc 05, M3): customers, plans, usage, payments and
 * webhooks, server-rendered with Hono's escaping `html` helper and no bundler,
 * like the checkout and portal.
 *
 * Sign-in is with a secret key, which picks the org and environment. The cookie
 * holds a random session token (never the key), is HttpOnly and SameSite=Strict,
 * which is what keeps the few POST forms here safe from cross-site requests.
 *
 * Publishing a plan from here uses the merchant's browser wallet: the server
 * builds createPlan with the merchant as fee payer, the wallet signs, the server
 * sends it, then checks the plan on-chain exactly as `nummo plans publish` does.
 */

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import {
  createDashboardSession,
  type Db,
  endDashboardSession,
  getCustomer,
  grantBalance,
  listCustomers,
  listEvents,
  listPayments,
  NummoError,
  overview,
  resolveDashboardSession,
  type Scope,
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
import { BASE_CSS, WALLET_JS } from "./page-kit.ts";

const COOKIE = "nummo_dash";
type Session = Scope & { org: string };
type Vars = { Variables: { session: Session } };
type Page = HtmlEscapedString | Promise<HtmlEscapedString>;

const fmt = (iso: string | null | undefined) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "");
const short = (s: string | null | undefined) => (s && s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : (s ?? ""));
const num = (s: string) => Number(s).toLocaleString("en-US", { maximumFractionDigits: 6 });

const CSS = /* css */ `
${BASE_CSS}
  .top { border-bottom: 1px solid var(--line); background: var(--card); }
  .top .in { max-width: 1120px; margin: 0 auto; padding: 12px 16px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
  .top .brand { font-weight: 700; letter-spacing: -.01em; }
  .top nav { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
  .top nav a { color: var(--muted); text-decoration: none; padding: 6px 10px; border-radius: 8px; }
  .top nav a.on, .top nav a:hover { color: var(--fg); background: var(--chip); }
  main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 16px; }
  h1 { font-size: 22px; margin: 0; } h2 { font-size: 16px; margin: 0 0 12px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .tile .v { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile .k { color: var(--muted); font-size: 13px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 8px 8px; border-top: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
  td.wrap { white-space: normal; overflow-wrap: anywhere; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; border-top: 0; }
  .num { text-align: right; }
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-top: 8px; }
  .bars span { flex: 1; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 1px; opacity: .85; }
  .bars span:hover { opacity: 1; }
  .axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 6px; }
  form.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .login { max-width: 420px; margin: 10vh auto; padding: 0 16px; }
  .login form { display: grid; gap: 12px; }
  .empty { color: var(--muted); padding: 12px 0; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
`;

function layout(s: Session | null, active: string, title: string, body: Page, script = "") {
  const link = (href: string, label: string, key: string) => html`<a href="${href}" class="${active === key ? "on" : ""}">${label}</a>`;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · nummo</title><style>${raw(CSS)}</style></head>
<body>
${s
  ? html`<div class="top"><div class="in"><span class="brand">nummo</span>
  <nav>${link("/dashboard", "Overview", "overview")}${link("/dashboard/customers", "Customers", "customers")}${link("/dashboard/plans", "Plans", "plans")}${link("/dashboard/payments", "Payments", "payments")}${link("/dashboard/usage", "Usage", "usage")}${link("/dashboard/webhooks", "Webhooks", "webhooks")}</nav>
  <span class="muted">${s.org}</span><span class="chip ${s.env === "live" ? "ok" : "warn"}">${s.env === "live" ? "live · mainnet" : "test · devnet"}</span>
  <form method="post" action="/dashboard/logout"><button class="secondary">Sign out</button></form></div></div>`
  : ""}
${body}
${script ? html`<script>${raw(WALLET_JS)}${raw(script)}</script>` : ""}
</body></html>`;
}

function explorer(sig: string, network: string | undefined) {
  const href = `https://explorer.solana.com/tx/${sig}${network && network !== "mainnet" ? `?cluster=${network}` : ""}`;
  return html`<a class="mono" href="${href}" target="_blank" rel="noopener">${short(sig)}</a>`;
}

const statusChip = (st: string) => {
  const cls = { active: "ok", past_due: "bad", canceling: "warn", pending: "warn", paid: "ok", open: "warn", uncollectible: "bad", delivered: "ok", dead: "bad", retrying: "warn", finalized: "ok", confirmed: "ok", reverted: "bad" }[st] ?? "";
  return html`<span class="chip ${cls}">${st.replace("_", " ")}</span>`;
};

export function dashboard(db: Db, chains: Chains, settings: SettlementSettings) {
  const app = new Hono<Vars>();
  const secure = settings.publicUrl.startsWith("https://");

  app.onError((err, c) => {
    if (err instanceof NummoError) {
      if (c.req.header("accept")?.includes("application/json") || c.req.header("content-type")?.includes("application/json")) {
        return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
      }
      const s = c.get("session") ?? null;
      return c.html(layout(s, "", "Error", html`<main><div class="card"><h2>Something went wrong</h2><p class="status bad">${err.message}</p><a href="javascript:history.back()">Back</a></div></main>`), err.status as 400);
    }
    throw err;
  });

  // ---------------------------------------------------------------- sign in

  const loginPage = (error?: string) =>
    layout(
      null,
      "",
      "Sign in",
      html`<div class="login"><div class="card"><div class="merchant">nummo</div><h1 style="margin:4px 0 16px">Dashboard</h1>
<form method="post" action="/dashboard/login"><label for="key" class="muted">Secret key</label>
<input id="key" name="key" type="password" autocomplete="off" placeholder="nummo_sk_test_…" required>
<button>Sign in</button>${error ? html`<p class="status bad">${error}</p>` : ""}</form>
<p class="note" style="margin:16px 0 0">A test key shows devnet data, a live key mainnet. Create one with <span class="mono">pnpm --filter @usenummo/api bootstrap</span>.</p></div></div>`,
    );

  app.get("/login", (c) => c.html(loginPage()));
  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const s = await createDashboardSession(db, String(form.key ?? ""));
    if (!s) return c.html(loginPage("That key is not valid."), 401);
    setCookie(c, COOKIE, s.token, { httpOnly: true, sameSite: "Strict", secure, path: "/dashboard", expires: s.expiresAt });
    return c.redirect("/dashboard");
  });
  app.post("/logout", async (c) => {
    const t = getCookie(c, COOKIE);
    if (t) await endDashboardSession(db, t);
    deleteCookie(c, COOKIE, { path: "/dashboard" });
    return c.redirect("/dashboard/login");
  });

  app.use("*", async (c, next) => {
    const t = getCookie(c, COOKIE);
    const s = t ? await resolveDashboardSession(db, t) : null;
    if (!s) return c.redirect("/dashboard/login");
    c.set("session", s);
    await next();
  });

  const scopeOf = (c: Context<Vars>): Scope => ({ orgId: c.get("session").orgId, env: c.get("session").env });
  const network = (c: Context<Vars>) => chains[c.get("session").env]?.network;

  // ---------------------------------------------------------------- overview

  app.get("/", async (c) => {
    const o = await overview(db, scopeOf(c));
    const max = Math.max(...o.daily.map((d) => Number(d.amount)), 0);
    const chain = chains[c.get("session").env];
    return c.html(
      layout(
        c.get("session"),
        "overview",
        "Overview",
        html`<main>
<div class="head"><h1>Overview</h1><span class="muted">${chain ? html`Settling on ${chain.network} · puller <span class="mono">${short(chain.pullerAddress)}</span>` : "Settlement is off for this environment"}</span></div>
<div class="tiles">
  <div class="tile"><div class="k">Customers</div><div class="v">${o.customers.toLocaleString()}</div></div>
  <div class="tile"><div class="k">Paid subscribers</div><div class="v">${o.paidSubscribers}</div></div>
  <div class="tile"><div class="k">30-day run rate</div><div class="v">${num(o.runRate30d)} <span class="muted" style="font-size:13px">USDC</span></div></div>
  <div class="tile"><div class="k">Collected, last 30 days</div><div class="v">${num(o.collected30d)} <span class="muted" style="font-size:13px">USDC</span></div></div>
  <div class="tile"><div class="k">Past due</div><div class="v" style="color:${o.pastDue ? "var(--bad)" : "inherit"}">${o.pastDue}</div></div>
</div>
<div class="card"><h2>Collected per day</h2>
  <div class="bars" role="img" aria-label="USDC collected per day, last 30 days">${o.daily.map((d) => html`<span title="${d.day}: ${d.amount} USDC" style="height:${max ? Math.max((Number(d.amount) / max) * 100, Number(d.amount) > 0 ? 3 : 0.5) : 0.5}%"></span>`)}</div>
  <div class="axis"><span>${o.daily[0]!.day}</span><span>${o.payments30d} payments</span><span>${o.daily.at(-1)!.day}</span></div></div>
<div class="grid2">
  <div class="card"><h2>Usage, last 30 days</h2>${o.usage.length
    ? html`<table><thead><tr><th>Feature</th><th class="num">Total</th><th class="num">Events</th></tr></thead><tbody>${o.usage.map((u) => html`<tr><td>${u.featureId}</td><td class="num">${num(u.total)}</td><td class="num">${u.events.toLocaleString()}</td></tr>`)}</tbody></table>`
    : html`<p class="empty">No usage yet.</p>`}</div>
  <div class="card"><h2>Webhooks, last 30 days</h2>${o.webhookEndpoint
    ? html`<dl><dt>Waiting to deliver</dt><dd>${o.webhooks.pending}</dd><dt>Retrying</dt><dd>${o.webhooks.failing}</dd><dt>Gave up</dt><dd style="color:${o.webhooks.dead ? "var(--bad)" : "inherit"}">${o.webhooks.dead}</dd></dl>`
    : html`<p class="empty">No endpoint registered, so events are kept but not sent. Register one with <span class="mono">PUT /v1/webhook</span>.</p>`}<a href="/dashboard/webhooks">Events</a></div>
</div>
<div class="card"><h2>Recent payments</h2>${paymentsTable(o.recentPayments, network(c))}</div>
</main>`,
      ),
    );
  });

  function paymentsTable(rows: Awaited<ReturnType<typeof listPayments>>, net: string | undefined) {
    if (!rows.length) return html`<p class="empty">No payments yet.</p>`;
    return html`<div class="scroll"><table><thead><tr><th>When</th><th>Customer</th><th>For</th><th class="num">Amount</th><th>Status</th><th>Transaction</th></tr></thead><tbody>
${rows.map((p) => html`<tr><td>${fmt(p.createdAt)}</td><td><a href="/dashboard/customers/${encodeURIComponent(p.customerId)}">${p.customerId}</a></td><td>${p.kind}</td><td class="num">${p.amount} USDC</td><td>${statusChip(p.status)}</td><td>${explorer(p.signature, net)}</td></tr>`)}
</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- customers

  app.get("/customers", async (c) => {
    const search = c.req.query("q") ?? "";
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const r = await listCustomers(db, scopeOf(c), { search: search || undefined, limit: 50, offset });
    return c.html(
      layout(
        c.get("session"),
        "customers",
        "Customers",
        html`<main><div class="head"><h1>Customers</h1><form class="inline" method="get"><input name="q" value="${search}" placeholder="Search id, name or email"><button class="secondary">Search</button></form></div>
<div class="card scroll">${r.customers.length
          ? html`<table><thead><tr><th>Customer</th><th>Name</th><th>Email</th><th>Plan</th><th>Since</th></tr></thead><tbody>
${r.customers.map((x) => html`<tr><td><a href="/dashboard/customers/${encodeURIComponent(x.id)}">${x.id}</a></td><td>${x.name ?? ""}</td><td>${x.email ?? ""}</td><td>${x.plans.map((p) => html`${p.name} ${p.status !== "active" ? statusChip(p.status) : ""} `)}</td><td>${fmt(x.createdAt)}</td></tr>`)}
</tbody></table>`
          : html`<p class="empty">No customers${search ? " match" : " yet"}.</p>`}</div>
<div class="head"><span class="muted">${r.total.toLocaleString()} in all</span><span>${offset > 0 ? html`<a href="?q=${search}&offset=${Math.max(offset - 50, 0)}">Previous</a> ` : ""}${offset + 50 < r.total ? html`<a href="?q=${search}&offset=${offset + 50}">Next</a>` : ""}</span></div></main>`,
      ),
    );
  });

  app.get("/customers/:id", async (c) => {
    const scope = scopeOf(c);
    const id = c.req.param("id");
    const [cust, events] = await Promise.all([getCustomer(db, scope, id), listEvents(db, scope, { customerId: id, limit: 25 })]);
    const net = network(c);
    return c.html(
      layout(
        c.get("session"),
        "customers",
        id,
        html`<main><div class="head"><div><div class="merchant">Customer</div><h1>${cust.id}</h1><span class="muted">${[cust.name, cust.email].filter(Boolean).join(" · ")}</span></div>
<form method="post" action="/dashboard/customers/${encodeURIComponent(id)}/portal" target="_blank"><button class="secondary">Open their billing portal</button></form></div>
<div class="card scroll"><h2>Subscriptions</h2><table><thead><tr><th>Plan</th><th>Status</th><th class="num">Price</th><th class="num">Ceiling</th><th>Period ends</th><th>Wallet</th><th>Note</th></tr></thead><tbody>
${cust.subscriptions.map((s) => html`<tr><td>${s.planName} <span class="muted">v${s.version}</span></td><td>${statusChip(s.status)}</td><td class="num">${s.price ? `${s.price.amount} USDC ${s.price.period}` : "free"}</td><td class="num">${s.ceiling ?? ""}</td><td>${fmt(s.cancelAt ?? s.currentPeriodEnd)}</td><td class="mono">${short(s.wallet)}</td><td class="wrap">${s.replacedBy ? "replaced by a plan change" : s.scheduledChange ? `moves to ${s.scheduledChange.name} at ${fmt(s.scheduledChange.effectiveAt)}` : (s.endedReason ?? "")}</td></tr>`)}
</tbody></table></div>
<div class="grid2"><div class="card"><h2>Balances</h2>${cust.balances.length
          ? html`<table><thead><tr><th>Feature</th><th class="num">Left</th><th class="num">Granted</th><th>From</th></tr></thead><tbody>${cust.balances.map((b) => html`<tr><td>${b.featureId}</td><td class="num">${num(b.balance)}</td><td class="num">${num(b.granted)}</td><td class="wrap">${[...new Set(b.breakdown.map((g) => g.source))].join(", ")}</td></tr>`)}</tbody></table>`
          : html`<p class="empty">No balances.</p>`}
  <form class="inline" method="post" action="/dashboard/customers/${encodeURIComponent(id)}/grant" style="margin-top:12px"><input name="featureId" placeholder="feature" required size="10"><input name="amount" placeholder="amount" required size="8" inputmode="decimal"><button class="secondary">Grant</button></form></div>
<div class="card scroll"><h2>Recent usage</h2>${events.length
          ? html`<table><thead><tr><th>When</th><th>Feature</th><th class="num">Value</th></tr></thead><tbody>${events.map((e) => html`<tr><td>${fmt(e.occurredAt)}</td><td>${e.featureId}</td><td class="num">${num(e.value)}</td></tr>`)}</tbody></table>`
          : html`<p class="empty">No usage yet.</p>`}</div></div>
<div class="card scroll"><h2>Invoices</h2>${cust.invoices.length
          ? html`<table><thead><tr><th>Created</th><th>Kind</th><th>Lines</th><th class="num">Total</th><th>Status</th><th>Payments</th></tr></thead><tbody>
${cust.invoices.map((i) => html`<tr><td>${fmt(i.createdAt)}</td><td>${i.kind}</td><td class="wrap">${i.lines.map((l) => `${l.kind}${l.featureId ? ` ${l.featureId}` : ""}${l.quantity ? ` ×${num(l.quantity)}` : ""}: ${l.amount}`).join("; ")}</td><td class="num">${i.total} USDC</td><td>${statusChip(i.status)}</td><td>${i.payments.map((p) => html`${explorer(p.signature, net)} `)}</td></tr>`)}
</tbody></table>`
          : html`<p class="empty">No invoices.</p>`}</div></main>`,
      ),
    );
  });

  app.post("/customers/:id/portal", async (c) => {
    const r = await createPortalSession(db, scopeOf(c), { customerId: c.req.param("id") }, settings.publicUrl);
    return c.redirect(r.url);
  });

  app.post("/customers/:id/grant", async (c) => {
    const form = await c.req.parseBody();
    await grantBalance(db, scopeOf(c), { customerId: c.req.param("id"), featureId: String(form.featureId ?? ""), amount: String(form.amount ?? "") });
    return c.redirect(`/dashboard/customers/${encodeURIComponent(c.req.param("id"))}`);
  });

  // ---------------------------------------------------------------- plans and publishing

  app.get("/plans", async (c) => {
    const r = await listPlanVersions(db, scopeOf(c), chains[c.get("session").env], settings.publicUrl);
    return c.html(
      layout(
        c.get("session"),
        "plans",
        "Plans",
        html`<main><div class="head"><h1>Plans</h1><span class="muted">${r.settlement ? html`${r.settlement.network} · mint <span class="mono">${short(r.settlement.mint)}</span>` : "Settlement is off: paid plans cannot be published"}</span></div>
<div class="card scroll"><table><thead><tr><th>Plan</th><th>Name</th><th class="num">Base</th><th class="num">Ceiling</th><th>Period</th><th>On-chain plan</th></tr></thead><tbody>
${r.versions.map((v) => html`<tr><td>${v.planId}@${v.version}</td><td>${v.name}</td><td class="num">${v.paid ? `${v.base} USDC` : "free"}</td><td class="num">${v.onchainTerms ? `${v.onchainTerms.ceiling} USDC` : ""}</td><td>${v.onchainTerms?.period ?? ""}</td>
<td>${!v.paid ? html`<span class="muted">none needed</span>` : v.published ? html`<span class="mono">${short(v.published.address)}</span>` : r.settlement ? html`<button data-plan="${v.planId}" data-version="${v.version}">Publish with wallet</button>` : html`<span class="chip bad">not published</span>`}</td></tr>`)}
</tbody></table><div class="wallets" id="wallets" style="display:grid;gap:8px;margin-top:12px;max-width:360px"></div><div class="status" id="status"></div>
<p class="note" style="margin:12px 0 0">Publishing creates the Solana Subscriptions plan from your own wallet, which owns it, pays its rent and receives every payment. The amount and period cannot change afterwards. The CLI does the same with a keypair file: <span class="mono">nummo plans publish --keypair merchant.json</span>.</p></div></main>`,
        PUBLISH_JS(r.settlement?.network ?? "devnet"),
      ),
    );
  });

  app.post("/plans/:planId/:version/transaction", async (c) => {
    const scope = scopeOf(c);
    const chain = chains[scope.env];
    if (!chain) throw new NummoError("settlement_unavailable", "settlement is not configured for this environment");
    const { owner } = (await c.req.json()) as { owner: string };
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
    const b = (await c.req.json()) as { owner: string; signedTransaction: string; message: string; lastValidBlockHeight: string; planAddress: string };
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

  // ---------------------------------------------------------------- payments, usage, webhooks

  app.get("/payments", async (c) => {
    const rows = await listPayments(db, scopeOf(c), { limit: 200 });
    return c.html(layout(c.get("session"), "payments", "Payments", html`<main><h1>Payments</h1><div class="card">${paymentsTable(rows, network(c))}</div></main>`));
  });

  app.get("/usage", async (c) => {
    const scope = scopeOf(c);
    const featureId = c.req.query("feature") || undefined;
    const [o, events] = await Promise.all([overview(db, scope), listEvents(db, scope, { featureId, limit: 200 })]);
    return c.html(
      layout(
        c.get("session"),
        "usage",
        "Usage",
        html`<main><h1>Usage</h1>
<div class="tiles">${o.usage.map((u) => html`<a class="tile" style="text-decoration:none;color:inherit" href="?feature=${u.featureId}"><div class="k">${u.featureId}, 30 days</div><div class="v">${num(u.total)}</div><div class="k">${u.events.toLocaleString()} events</div></a>`)}</div>
<div class="card scroll"><div class="head"><h2>${featureId ? `Events for ${featureId}` : "Recent events"}</h2>${featureId ? html`<a href="/dashboard/usage">All features</a>` : ""}</div>${events.length
          ? html`<table><thead><tr><th>When</th><th>Customer</th><th>Feature</th><th class="num">Value</th><th>Properties</th></tr></thead><tbody>${events.map((e) => html`<tr><td>${fmt(e.occurredAt)}</td><td><a href="/dashboard/customers/${encodeURIComponent(e.customerId)}">${e.customerId}</a></td><td>${e.featureId}</td><td class="num">${num(e.value)}</td><td class="wrap mono">${e.properties ? JSON.stringify(e.properties) : ""}</td></tr>`)}</tbody></table>`
          : html`<p class="empty">No usage yet.</p>`}</div></main>`,
      ),
    );
  });

  app.get("/webhooks", async (c) => {
    const w = await webhookStatus(db, scopeOf(c));
    return c.html(
      layout(
        c.get("session"),
        "webhooks",
        "Webhooks",
        html`<main><div class="head"><h1>Webhooks</h1><span class="muted">${w.endpoint ? html`Delivering to <span class="mono">${w.endpoint.url}</span>` : "No endpoint registered. Set one with PUT /v1/webhook."}</span></div>
<div class="card scroll">${w.events.length
          ? html`<table><thead><tr><th>When</th><th>Event</th><th>State</th><th class="num">Attempts</th><th>Details</th></tr></thead><tbody>${w.events.map((e) => html`<tr><td>${fmt(e.createdAt)}</td><td>${e.type}</td><td>${statusChip(e.state)}</td><td class="num">${e.attempts}</td><td class="wrap mono">${e.lastError ?? JSON.stringify(e.payload).slice(0, 160)}</td></tr>`)}</tbody></table>`
          : html`<p class="empty">No events yet.</p>`}</div></main>`,
      ),
    );
  });

  return app;
}

const PUBLISH_JS = (network: string) => /* js */ `
(() => {
  const $ = (x) => document.getElementById(x);
  const status = (t, cls = "") => { $("status").textContent = t; $("status").className = "status " + cls; };
  let target = null;
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
    return j;
  }
  async function publish(w) {
    const base = "/dashboard/plans/" + encodeURIComponent(target.plan) + "/" + target.version;
    try {
      status("Connecting to " + w.name + "…");
      const account = await nummoWallets.connect(w);
      const built = await post(base + "/transaction", { owner: account.address });
      status("Approve the plan in " + w.name + ". Your wallet pays the rent for the plan account (a little SOL).");
      const signedTransaction = await nummoWallets.sign(w, account, built.transaction, ${JSON.stringify(network)});
      status("Publishing…");
      await post(base + "/submit", { owner: account.address, signedTransaction, message: built.message, lastValidBlockHeight: built.lastValidBlockHeight, planAddress: built.planAddress });
      location.reload();
    } catch (e) { status(e.message || String(e), "bad"); }
  }
  for (const b of document.querySelectorAll("button[data-plan]")) {
    b.onclick = () => { target = { plan: b.dataset.plan, version: b.dataset.version }; status("Publishing " + target.plan + "@" + target.version + ": pick the merchant wallet."); nummoWallets.buttons($("wallets"), "Sign with", publish); };
  }
})();
`;
