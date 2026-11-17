/**
 * The customer portal page (doc 04, "Customer portal"): plan, on-chain ceiling,
 * usage this period, receipts with transaction links, plan changes, top-ups,
 * and cancel or resume signed by the customer's own wallet. Data comes from
 * /portal/:id/data; the page holds no secrets.
 */

import { BASE_CSS, WALLET_JS } from "./page-kit.ts";

export const PORTAL_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Billing</title>
<style>
${BASE_CSS}
  main { max-width: 760px; margin: 0 auto; padding: 28px 16px 48px; display: grid; gap: 16px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
  .plan { border: 1px solid var(--line); border-radius: 12px; padding: 14px; display: grid; gap: 6px; align-content: start; }
  .plan.current { border-color: var(--accent); }
  .plan .chip { justify-self: start; }
  .plan .price { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; background: var(--track); border-radius: 999px; overflow: hidden; margin: 6px 0 4px; }
  .bar > span { display: block; height: 100%; background: var(--accent); }
  .usage { display: grid; gap: 14px; }
  .usage .top { display: flex; justify-content: space-between; gap: 8px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 8px 6px; border-top: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; border-top: 0; }
  td.num, th.num { text-align: right; }
  .wallets { display: grid; gap: 8px; margin-top: 12px; }
  .notice { background: var(--chip); border-radius: 10px; padding: 10px 12px; margin: 12px 0 0; }
  .scroll { overflow-x: auto; }
  @media (max-width: 520px) { dl { grid-template-columns: 1fr; } dd { text-align: left; } }
</style>
</head>
<body>
<main>
  <header>
    <div><div class="merchant" id="merchant">&nbsp;</div><h1>Billing</h1></div>
    <div class="row"><span class="chip" id="network" hidden></span><a id="back" class="button secondary" hidden>Back</a></div>
  </header>
  <section class="card" id="plan-card"><p class="muted">Loading…</p></section>
  <section class="card" id="plans-card" hidden><h2>Change plan</h2><div class="plans" id="plans"></div><div id="change-box"></div></section>
  <section class="card" id="usage-card" hidden><h2>Usage</h2><div class="usage" id="usage"></div></section>
  <section class="card" id="topup-card" hidden><h2>Top up</h2><div id="topup"></div></section>
  <section class="card" id="receipts-card" hidden><h2>Receipts</h2><div class="scroll" id="receipts"></div></section>
  <div class="status" id="status" role="status" aria-live="polite"></div>
  <p class="foot">Payments settle in USDC on Solana. Powered by nummo.</p>
</main>
<script>
${WALLET_JS}
(() => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const $ = (x) => document.getElementById(x);
  const status = (text, cls = "") => { const s = $("status"); s.textContent = text; s.className = "status " + cls; };
  let data = null;
  let busy = false;

  async function api(path, body) {
    const r = await fetch("/portal/" + id + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
    return j;
  }
  const lock = (on) => { busy = on; for (const b of document.querySelectorAll("button")) b.disabled = on; };
  const STATUS = { active: ["Active", "ok"], past_due: ["Payment failed", "bad"], canceling: ["Cancelled", "warn"], ended: ["Ended", ""], pending: ["Waiting for payment", "warn"] };

  function mainSub() {
    const live = data.customer.subscriptions.filter((s) => ["active", "past_due", "canceling"].includes(s.status) && !s.replacedBy);
    return live.find((s) => s.price) || live[0] || null;
  }

  function renderPlan() {
    const s = mainSub();
    const box = $("plan-card");
    if (!s) { box.innerHTML = "<h2>No plan</h2><p class=muted>You are not on a plan.</p>"; return; }
    const [label, cls] = STATUS[s.status] || [s.status, ""];
    let rows = "";
    if (s.price) {
      rows += "<dt>Price</dt><dd>" + esc(s.price.amount) + " USDC " + esc(s.price.period) + "</dd>";
      rows += "<dt>Most you can be charged</dt><dd>" + esc(s.ceiling) + " USDC per period</dd>";
      if (s.currentPeriodEnd) rows += "<dt>" + (s.cancelAt ? "Ends" : "Renews") + "</dt><dd>" + esc(fmtDate(s.cancelAt || s.currentPeriodEnd)) + "</dd>";
      rows += "<dt>Wallet</dt><dd class=mono>" + esc(short(s.wallet)) + "</dd>";
    } else {
      rows += "<dt>Price</dt><dd>Free</dd>";
    }
    let notes = "";
    if (s.status === "past_due") notes += "<p class=notice>The last payment failed" + (s.nextRetryAt ? "; it is retried on " + esc(fmtDate(s.nextRetryAt)) : "") + ". Add USDC to your wallet to keep the plan.</p>";
    if (s.scheduledChange) notes += "<p class=notice>Moves to " + esc(s.scheduledChange.name) + " on " + esc(fmtDate(s.scheduledChange.effectiveAt)) + ". <button class=secondary id=keep>Keep " + esc(s.planName) + "</button></p>";
    for (const c of data.customer.pendingCheckouts.filter((c) => c.kind !== "topup")) {
      const p = data.plans.find((x) => x.planId === c.planId);
      notes += "<p class=notice>" + esc(p ? p.name : c.planId) + " is waiting for your signature. <a class='button' href='/checkout/" + esc(c.id) + "'>Finish</a></p>";
    }
    const actions = s.price && s.subscriptionAddress
      ? (s.cancelAt ? "<button id=resume>Resume plan</button>" : "<button class=danger id=cancel>Cancel plan</button>")
      : "";
    box.innerHTML = "<div class=row style='justify-content:space-between'><h2 style=margin:0>" + esc(s.planName) + "</h2><span class='chip " + cls + "'>" + esc(label) + "</span></div>" +
      "<dl>" + rows + "</dl>" + notes + "<div class=row>" + actions + "</div><div class=wallets id=plan-wallets></div>" +
      (s.price ? "<p class=note style='margin:12px 0 0'>Cancelling is signed by your wallet with the Solana Subscriptions program. The plan stays on until the end of the period, and nothing more can be collected after that.</p>" : "");
    if ($("cancel")) $("cancel").onclick = () => pickWallet("cancel", s);
    if ($("resume")) $("resume").onclick = () => pickWallet("resume", s);
    if ($("keep")) $("keep").onclick = () => change(s.planId, true);
  }

  function pickWallet(action, s) {
    nummoWallets.buttons($("plan-wallets"), action === "cancel" ? "Cancel with" : "Resume with", async (w) => {
      if (busy) return;
      lock(true);
      try {
        status("Connecting to " + w.name + "…");
        const account = await nummoWallets.connect(w);
        const { transaction } = await api("/transaction", { action, subscriptionId: s.id, wallet: account.address });
        status("Approve in " + w.name + "…");
        const signedTransaction = await nummoWallets.sign(w, account, transaction, data.network);
        status("Sending…");
        const r = await api("/submit", { signedTransaction });
        data = r.portal;
        renderAll();
        $("status").innerHTML = (action === "cancel" ? "Cancelled. " : "Resumed. ") + '<a target=_blank rel=noopener href="' + explorerTx(r.signature, data.network) + '">View the transaction</a>';
        $("status").className = "status ok";
      } catch (e) { status(e.message || String(e), "bad"); } finally { lock(false); }
    });
  }

  function renderPlans() {
    if (!data.plans.length) return;
    $("plans-card").hidden = false;
    $("plans").innerHTML = data.plans.map((p) =>
      "<div class='plan" + (p.current ? " current" : "") + "'><strong>" + esc(p.name) + "</strong>" +
      "<div class=price>" + (p.price ? esc(p.price.amount) + " <span class=muted style='font-size:13px;font-weight:500'>USDC " + esc(p.price.period) + "</span>" : "Free") + "</div>" +
      (p.ceiling ? "<div class=note style=margin:0>At most " + esc(p.ceiling) + " USDC a period</div>" : "") +
      (p.current ? "<span class=chip>Current</span>" : "<button class=secondary data-plan='" + esc(p.planId) + "'>Switch</button>") + "</div>").join("");
    for (const b of $("plans").querySelectorAll("button[data-plan]")) b.onclick = () => change(b.dataset.plan, false);
  }

  async function change(planId, confirm) {
    if (busy) return;
    lock(true);
    try {
      if (!confirm) {
        const { preview: p } = await api("/change", { planId, confirm: false });
        const box = $("change-box");
        let text;
        if (p.change === "blocked") text = p.reason;
        else if (p.change === "upgrade") text = "Switch to " + p.plan.name + " now: pay " + p.dueNow + " USDC" + (Number(p.credit) > 0 ? " (" + p.credit + " USDC credit for unused time)" : "") + ", signed once with your wallet.";
        else if (p.change === "downgrade") text = "Moves to " + p.plan.name + " on " + fmtDate(p.effectiveAt) + ", when the current period ends." + (p.plan.price ? " You will be asked to sign the new plan then." : "");
        else text = (p.plan.price ? "Subscribe to " + p.plan.name + " for " + p.dueNow + " USDC, signed once with your wallet." : "Move to " + p.plan.name + ".");
        box.innerHTML = "<p class=notice>" + esc(text) + "</p>" + (p.change === "blocked" ? "" : "<div class=row style=margin-top:10px><button id=go>Continue</button><button class=secondary id=nevermind>Not now</button></div>");
        if ($("go")) $("go").onclick = () => change(planId, true);
        if ($("nevermind")) $("nevermind").onclick = () => (box.innerHTML = "");
        return;
      }
      const { result } = await api("/change", { planId, confirm: true });
      if (result.checkoutUrl) { location.assign(result.checkoutUrl); return; }
      await refresh();
      status(result.status === "scheduled" ? "Scheduled for " + fmtDate(result.effectiveAt) + "." : "Done.", "ok");
    } catch (e) { status(e.message || String(e), "bad"); } finally { lock(false); }
  }

  function renderUsage() {
    const bs = data.customer.balances.filter((b) => Number(b.granted) > 0);
    if (!bs.length) return;
    $("usage-card").hidden = false;
    $("usage").innerHTML = bs.map((b) => {
      const pct = Math.max(0, Math.min(100, (Number(b.balance) / Number(b.granted)) * 100));
      const parts = {};
      for (const g of b.breakdown) parts[g.source] = (parts[g.source] || 0) + Number(g.remaining);
      const detail = Object.entries(parts).map(([k, v]) => (k === "plan" ? "plan " : k === "topup" ? "purchased " : k + " ") + v.toLocaleString()).join(" · ");
      return "<div><div class=top><strong>" + esc(b.featureId) + "</strong><span>" + Number(b.balance).toLocaleString() + " of " + Number(b.granted).toLocaleString() + " left</span></div>" +
        "<div class=bar><span style='width:" + pct.toFixed(1) + "%'></span></div><div class=note style=margin:0>" + esc(detail) + "</div></div>";
    }).join("");
  }

  function renderTopUp() {
    if (!data.topUps.length) return;
    $("topup-card").hidden = false;
    const t0 = data.topUps[0];
    $("topup").innerHTML = "<div class=row>" +
      (data.topUps.length > 1 ? "<select id=tf>" + data.topUps.map((t) => "<option value='" + esc(t.featureId) + "'>" + esc(t.featureId) + "</option>").join("") + "</select>" : "") +
      "<input id=ta type=number min='" + esc(t0.min) + "' max='" + esc(t0.max) + "' step='any' value='" + esc(Math.max(Number(t0.min), 10)) + "' style='width:120px' aria-label='Amount in USDC'> <span class=muted>USDC</span>" +
      "<button id=tb>Buy</button></div><p class=note id=tq style='margin:8px 0 0'></p>";
    const feature = () => data.topUps.find((t) => t.featureId === ($("tf") ? $("tf").value : t0.featureId));
    const quote = () => { const t = feature(); const n = (Number($("ta").value) / Number(t.price)) * Number(t.per); $("tq").textContent = "= " + (isFinite(n) ? Math.floor(n).toLocaleString() : 0) + " " + t.featureId + ". Purchased balance does not expire."; };
    $("ta").oninput = quote; if ($("tf")) $("tf").onchange = quote; quote();
    $("tb").onclick = async () => {
      if (busy) return;
      lock(true);
      try {
        const [w, f = ""] = String($("ta").value).split(".");
        const units = (BigInt(w || "0") * 1000000n + BigInt((f + "000000").slice(0, 6))).toString();
        const r = await api("/topup", { featureId: feature().featureId, amount: units });
        location.assign(r.checkoutUrl);
      } catch (e) { status(e.message || String(e), "bad"); lock(false); }
    };
  }

  function renderReceipts() {
    const inv = data.customer.invoices;
    if (!inv.length) return;
    $("receipts-card").hidden = false;
    const KIND = { activation: "Subscription", renewal: "Renewal", overage: "Usage", topup: "Top-up" };
    $("receipts").innerHTML = "<table><thead><tr><th>Date</th><th>For</th><th class=num>Amount</th><th>Status</th><th>Transaction</th></tr></thead><tbody>" +
      inv.map((i) => "<tr><td>" + esc(fmtDate(i.createdAt)) + "</td><td>" + esc(i.lines.some((l) => l.kind === "proration") ? "Plan change" : KIND[i.kind] || i.kind) + "</td><td class=num>" + esc(i.total) + " USDC</td><td>" + esc(i.status) + "</td><td>" +
        (i.payments.map((p) => "<a class=mono target=_blank rel=noopener href='" + explorerTx(p.signature, data.network) + "'>" + esc(short(p.signature)) + "</a>").join("<br>") || "<span class=muted>none</span>") + "</td></tr>").join("") +
      "</tbody></table>";
  }

  function renderAll() {
    $("merchant").textContent = data.merchant;
    if (data.network) { const n = $("network"); n.hidden = false; n.textContent = data.network === "mainnet" ? "Solana" : "Solana " + data.network; }
    if (data.returnUrl) { const b = $("back"); b.hidden = false; b.href = data.returnUrl; }
    renderPlan(); renderPlans(); renderUsage(); renderTopUp(); renderReceipts();
  }

  async function refresh() {
    try { data = await api("/data"); renderAll(); } catch (e) { $("plan-card").innerHTML = "<p class=status.bad>" + esc(e.message) + "</p>"; }
  }
  nummoWallets.onChange(() => { /* wallets appear late; buttons are drawn on demand */ });
  refresh();
})();
</script>
</body>
</html>`;
