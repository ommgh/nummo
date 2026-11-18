/**
 * The hosted checkout page (doc 03, "Activation: one signature", "Plan changes",
 * "One-off purchases"). Plain HTML and JS, no bundler: wallets are discovered
 * with the Wallet Standard's two window events, which every current Solana
 * wallet (Phantom, Solflare, Backpack) implements. The page never broadcasts:
 * the wallet signs, the server checks, co-signs and sends.
 */

import { BASE_CSS, WALLET_JS } from "./page-kit.ts";

export const CHECKOUT_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout</title>
<style>
${BASE_CSS}
  main { max-width: 440px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 28px; margin: 8px 0 16px; }
  .wallets { display: grid; gap: 8px; }
</style>
</head>
<body>
<main>
  <div class="card">
    <div class="merchant" id="merchant">&nbsp;</div>
    <h1 id="title">Loading…</h1>
    <span class="chip" id="network" hidden></span>
    <dl id="terms" hidden></dl>
    <p class="note" id="explain" hidden></p>
    <div class="wallets" id="wallets"></div>
    <div class="status" id="status" role="status" aria-live="polite"></div>
  </div>
  <p class="foot">Payments settle in USDC on Solana. Powered by nummo.</p>
</main>
<script>
${WALLET_JS}
(() => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const $ = (x) => document.getElementById(x);
  const status = (text, cls = "") => { const s = $("status"); s.textContent = text; s.className = "status " + cls; };
  let session = null;
  let busy = false;

  async function api(path, body) {
    const r = await fetch("/checkout/" + id + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
    return j;
  }

  function terms(rows) {
    const dl = $("terms");
    dl.hidden = false;
    dl.innerHTML = rows.map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>").join("");
  }

  function render() {
    const box = $("wallets");
    if (!session) return;
    box.innerHTML = "";
    if (session.status === "completed") return;
    if (session.status === "expired") { status("This checkout link has expired. Ask the merchant for a new one.", "bad"); return; }
    if (session.kind !== "topup" && !session.onchain) { status("This plan is not available on-chain.", "bad"); return; }
    const verb = session.kind === "topup" ? "Pay with" : session.kind === "change" ? "Switch with" : "Pay with";
    nummoWallets.buttons(box, verb, pay);
    if (session.requiredWallet) {
      const p = document.createElement("p");
      p.className = "note";
      p.innerHTML = "Use the wallet that pays for your current plan: <span class=mono>" + esc(short(session.requiredWallet)) + "</span>";
      box.prepend(p);
    }
  }
  nummoWallets.onChange(render);

  function show(s) {
    session = s;
    $("merchant").textContent = s.merchant;
    const n = $("network"); n.hidden = false; n.textContent = s.network === "mainnet" ? "Solana" : "Solana " + s.network;
    const explain = $("explain");
    if (s.kind === "topup") {
      const name = (s.topup.feature && (s.topup.feature.name || s.topup.feature.id)) || "balance";
      $("title").textContent = "Buy " + Number(s.topup.quantity).toLocaleString() + " " + name;
      terms([["Price", s.firstCharge + " USDC"], ["Paid to", short(s.topup.payTo)]]);
      explain.hidden = false;
      explain.textContent = "A one-off payment: your wallet sends the amount above to the merchant, once. You pay no network fees and need no SOL.";
    } else if (s.plan) {
      $("title").textContent = s.kind === "change" ? "Switch to " + s.plan.name : s.plan.name;
      if (s.onchain) {
        const rows = [];
        if (s.kind === "change") {
          rows.push(["From", s.change.from.name]);
          if (Number(s.change.credit) > 0) rows.push(["Credit for unused time", "−" + s.change.credit + " USDC"]);
        }
        rows.push(["Due now", s.firstCharge + " USDC"]);
        rows.push(["Most you can be charged", s.onchain.ceiling + " USDC " + s.onchain.period.replace("every ", "per ")]);
        rows.push(["Billing period", s.onchain.period + ", starting now"]);
        terms(rows);
        explain.hidden = false;
        explain.textContent = (s.kind === "change"
          ? "You sign once: the new subscription starts now and your current one is cancelled; it can still collect usage you already had this period. "
          : "You sign once. ") +
          "The merchant can then collect up to the amount above each period, and never more: the Solana Subscriptions program enforces it. You pay no network fees and need no SOL. Cancel any time from your wallet.";
      }
    }
    if (s.status === "completed") {
      $("status").innerHTML = (s.kind === "topup" ? "Paid. " : s.kind === "change" ? "Switched. " : "Subscribed. ") +
        '<a href="' + explorerTx(s.signature, s.network) + '" target="_blank" rel="noopener">View the transaction</a>';
      $("status").className = "status ok";
      if (s.successUrl) setTimeout(() => location.assign(s.successUrl), 2500);
    } else if (s.status === "submitted") {
      status("Payment sent. Waiting for the network to confirm…");
      setTimeout(refresh, 2000);
    } else if (s.error && !busy) {
      status(s.error, "bad");
    }
    render();
  }

  async function refresh() { try { show(await api("/session")); } catch (e) { status(e.message, "bad"); } }

  async function pay(w) {
    if (busy) return;
    busy = true;
    for (const b of document.querySelectorAll("button")) b.disabled = true;
    try {
      status("Connecting to " + w.name + "…");
      const account = await nummoWallets.connect(w);
      status("Preparing the transaction…");
      const { transaction, amount } = await api("/transaction", { wallet: account.address });
      if (session.kind === "change") $("terms").querySelectorAll("dd")[session.change && Number(session.change.credit) > 0 ? 2 : 1].textContent = amount + " USDC";
      status("Approve in " + w.name + "…");
      const signedTransaction = await nummoWallets.sign(w, account, transaction, session.network);
      status("Sending…");
      show(await api("/submit", { signedTransaction }));
    } catch (e) {
      status(e && e.message ? e.message : String(e), "bad");
    } finally {
      busy = false;
      for (const b of document.querySelectorAll("button")) b.disabled = false;
    }
  }

  refresh();
})();
</script>
</body>
</html>`;
