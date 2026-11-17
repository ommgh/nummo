/**
 * The hosted checkout page (doc 03, "Activation: one signature"). Plain HTML and
 * JS, no bundler: wallets are discovered with the Wallet Standard's two window
 * events, which every current Solana wallet (Phantom, Solflare, Backpack)
 * implements. The page never broadcasts: the wallet signs, the server checks,
 * co-signs and sends.
 */

export const CHECKOUT_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout</title>
<style>
  :root {
    --bg: #f6f5f2; --card: #ffffff; --fg: #1d1b18; --muted: #6f6a62; --line: #e4e1db;
    --accent: #5b3cc4; --accent-fg: #ffffff; --ok: #1f7a4d; --bad: #b42318; --chip: #efecf9;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151413; --card: #1e1d1b; --fg: #f2f0ec; --muted: #a39e95; --line: #34322e;
      --accent: #a48cf0; --accent-fg: #151413; --ok: #5cc493; --bad: #f2877c; --chip: #2a2638; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 440px; margin: 0 auto; padding: 32px 16px 48px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  .merchant { color: var(--muted); font-size: 13px; letter-spacing: .02em; }
  h1 { font-size: 22px; margin: 4px 0 16px; }
  .chip { display: inline-block; background: var(--chip); color: var(--accent); border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 10px 16px; margin: 16px 0; }
  dt { color: var(--muted); } dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  .wallets { display: grid; gap: 8px; }
  button { width: 100%; display: flex; align-items: center; gap: 10px; justify-content: center; padding: 12px 14px; border-radius: 10px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
  button.wallet { background: transparent; color: var(--fg); border-color: var(--line); justify-content: flex-start; }
  button.wallet:hover { border-color: var(--accent); }
  button:disabled { opacity: .55; cursor: progress; }
  button img { width: 22px; height: 22px; border-radius: 6px; }
  .status { margin-top: 16px; min-height: 1.5em; overflow-wrap: anywhere; }
  .status.bad { color: var(--bad); } .status.ok { color: var(--ok); }
  a { color: var(--accent); }
  .foot { color: var(--muted); font-size: 12px; text-align: center; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <div class="card">
    <div class="merchant" id="merchant">&nbsp;</div>
    <h1 id="plan">Loading…</h1>
    <span class="chip" id="network" hidden></span>
    <dl id="terms" hidden>
      <dt>Due now</dt><dd id="now"></dd>
      <dt>Most you can be charged</dt><dd id="ceiling"></dd>
      <dt>Billing period</dt><dd id="period"></dd>
    </dl>
    <p class="note" id="explain" hidden>You sign once. The merchant can then collect up to the amount above each period, and never more:
      the Solana Subscriptions program enforces it. You pay no network fees and need no SOL. Cancel any time from your wallet.</p>
    <div class="wallets" id="wallets"></div>
    <div class="status" id="status" role="status" aria-live="polite"></div>
  </div>
  <p class="foot">Payments settle in USDC on Solana. Powered by nummo.</p>
</main>
<script>
(() => {
  const id = location.pathname.split("/").filter(Boolean).pop();
  const $ = (x) => document.getElementById(x);
  const status = (text, cls = "") => { const s = $("status"); s.textContent = text; s.className = "status " + cls; };
  const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const bytesToB64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  let session = null;
  let busy = false;

  async function api(path, body) {
    const r = await fetch("/checkout/" + id + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
    return j;
  }

  // ---- Wallet Standard discovery
  const wallets = [];
  const registry = { register: (...ws) => { for (const w of ws) if (!wallets.includes(w)) wallets.push(w); render(); return () => {}; } };
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(registry); } catch {} });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));

  const chainId = () => (session && session.network === "mainnet" ? "solana:mainnet" : "solana:devnet");
  const usable = (w) => w.features["standard:connect"] && w.features["solana:signTransaction"];

  function render() {
    const box = $("wallets");
    if (!session) return;
    box.innerHTML = "";
    if (session.status === "completed") return;
    if (session.status === "expired") { status("This checkout link has expired. Ask the merchant for a new one.", "bad"); return; }
    if (!session.onchain) { status("This plan is not available on-chain.", "bad"); return; }
    const list = wallets.filter(usable);
    if (list.length === 0) {
      box.innerHTML = '<p class="note">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</p>';
      return;
    }
    for (const w of list) {
      const b = document.createElement("button");
      b.className = "wallet";
      if (w.icon) { const img = document.createElement("img"); img.src = w.icon; img.alt = ""; b.append(img); }
      b.append(document.createTextNode("Pay with " + w.name));
      b.onclick = () => pay(w);
      box.append(b);
    }
  }

  function show(s) {
    session = s;
    $("merchant").textContent = s.merchant;
    $("plan").textContent = s.plan.name;
    const n = $("network"); n.hidden = false; n.textContent = s.network === "mainnet" ? "Solana" : "Solana " + s.network;
    if (s.onchain) {
      $("terms").hidden = false; $("explain").hidden = false;
      $("now").textContent = s.firstCharge + " USDC";
      $("ceiling").textContent = s.onchain.ceiling + " USDC " + s.onchain.period.replace("every ", "per ");
      $("period").textContent = s.onchain.period;
    }
    if (s.status === "completed") {
      const link = "https://explorer.solana.com/tx/" + s.signature + (s.network === "mainnet" ? "" : "?cluster=" + s.network);
      $("status").innerHTML = 'Subscribed. <a href="' + link + '" target="_blank" rel="noopener">View the transaction</a>';
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
      const { accounts } = await w.features["standard:connect"].connect();
      const account = (accounts && accounts[0]) || w.accounts[0];
      if (!account) throw new Error("The wallet did not share an account.");
      status("Preparing the transaction…");
      const { transaction } = await api("/transaction", { wallet: account.address });
      status("Approve the subscription in " + w.name + "…");
      const [out] = await w.features["solana:signTransaction"].signTransaction({ account, transaction: b64ToBytes(transaction), chain: chainId() });
      status("Sending…");
      show(await api("/submit", { signedTransaction: bytesToB64(out.signedTransaction) }));
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
