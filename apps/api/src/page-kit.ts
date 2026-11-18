/**
 * What the hosted pages share: tokens, base styles, and the Wallet Standard
 * client. Plain CSS and JS strings, no bundler (see checkout-page.ts).
 */

export const BASE_CSS = /* css */ `
  :root {
    --bg: #f2efe9; --card: #f8f6f2; --fg: #1b1a19; --muted: #6b665d; --line: rgb(27 26 25 / .16);
    --accent: #1764ff; --accent-fg: #ffffff; --ok: #3d7a2c; --warn: #a86800; --bad: #d93a12; --chip: #e8e4dc;
    --track: #e8e4dc; --marigold: #ffae0a; --tangerine: #ff5a1f; --iris: #9b6dff;
    --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.6 1.25'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E");
    --grain-opacity: .07;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1b1a19; --card: #222120; --fg: #f2efe9; --muted: #a39e94; --line: rgb(242 239 233 / .14);
      --accent: #2f74ff; --accent-fg: #ffffff; --ok: #a9cf45; --warn: #ffb726; --bad: #ff6a3d; --chip: #2a2927; --track: #2a2927; --grain-opacity: .12; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 "Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  body::after { content: ""; position: fixed; inset: 0; pointer-events: none; background: var(--grain); background-size: 200px; opacity: var(--grain-opacity); }
  h1, h2 { letter-spacing: -.03em; font-weight: 500; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 0; padding: 24px; position: relative; }
  .card::before { content: ""; position: absolute; top: -1px; left: -1px; right: -1px; height: 6px;
    background: linear-gradient(90deg, var(--accent) 0 25%, var(--tangerine) 25% 50%, var(--marigold) 50% 75%, var(--iris) 75%); }
  .muted { color: var(--muted); }
  .merchant, .label { color: var(--muted); font: 11px/1.3 "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
  .chip { display: inline-block; background: var(--chip); color: var(--fg); border-radius: 999px; padding: 2px 10px;
    font: 500 11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; }
  .chip.ok { color: var(--ok); } .chip.warn { color: var(--warn); } .chip.bad { color: var(--bad); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 10px 16px; margin: 16px 0; padding: 14px 0; border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line); }
  dt { color: var(--muted); } dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; overflow-wrap: anywhere; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  button, .button { display: inline-flex; align-items: center; gap: 10px; justify-content: center; padding: 10px 18px; border-radius: 999px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 500; cursor: pointer; text-decoration: none; transition: opacity .15s, border-color .15s; }
  button:hover, .button:hover { opacity: .9; }
  button.secondary, .button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
  button.secondary:hover { border-color: var(--fg); opacity: 1; }
  button.danger { background: transparent; color: var(--bad); border-color: var(--line); }
  button.wallet { width: 100%; background: var(--bg); color: var(--fg); border-color: var(--line); justify-content: flex-start; border-radius: 0; padding: 12px 14px; }
  button.wallet:hover { border-color: var(--fg); opacity: 1; }
  button:disabled { opacity: .55; cursor: progress; }
  button img { width: 22px; height: 22px; border-radius: 6px; }
  input, select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 0; padding: 9px 12px; }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .status { margin-top: 12px; min-height: 1.5em; overflow-wrap: anywhere; }
  .status.bad { color: var(--bad); } .status.ok { color: var(--ok); }
  a { color: var(--accent); }
  .foot { color: var(--muted); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; text-align: center; margin-top: 16px; }
  .mono { font-family: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
`;

/**
 * Wallet Standard discovery and helpers, as a script fragment. Defines
 * `nummoWallets` with:
 *   list()                      usable wallets (connect + solana:signTransaction)
 *   onChange(fn)                called when a wallet registers
 *   connect(wallet)             -> account
 *   sign(wallet, account, b64, network) -> signed transaction, base64
 * Every current Solana wallet (Phantom, Solflare, Backpack) implements the
 * two window events used here.
 */
export const WALLET_JS = /* js */ `
const nummoWallets = (() => {
  const wallets = [];
  const listeners = [];
  const registry = { register: (...ws) => { for (const w of ws) if (!wallets.includes(w)) wallets.push(w); listeners.forEach((f) => f()); return () => {}; } };
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(registry); } catch {} });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));
  const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const bytesToB64 = (u) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const usable = (w) => w.features["standard:connect"] && w.features["solana:signTransaction"];
  return {
    list: () => wallets.filter(usable),
    onChange: (f) => listeners.push(f),
    async connect(w) {
      const { accounts } = await w.features["standard:connect"].connect();
      const account = (accounts && accounts[0]) || w.accounts[0];
      if (!account) throw new Error("The wallet did not share an account.");
      return account;
    },
    async sign(w, account, transaction, network) {
      const chain = network === "mainnet" ? "solana:mainnet" : "solana:devnet";
      const [out] = await w.features["solana:signTransaction"].signTransaction({ account, transaction: b64ToBytes(transaction), chain });
      return bytesToB64(out.signedTransaction);
    },
    /** Buttons for each wallet, calling onPick(wallet). */
    buttons(box, label, onPick) {
      box.innerHTML = "";
      const list = this.list();
      if (list.length === 0) {
        box.innerHTML = '<p class="note">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload.</p>';
        return;
      }
      for (const w of list) {
        const b = document.createElement("button");
        b.className = "wallet";
        if (w.icon) { const img = document.createElement("img"); img.src = w.icon; img.alt = ""; b.append(img); }
        b.append(document.createTextNode(label + " " + w.name));
        b.onclick = () => onPick(w);
        box.append(b);
      }
    },
  };
})();
const explorerTx = (sig, network) => "https://explorer.solana.com/tx/" + sig + (network === "mainnet" ? "" : "?cluster=" + network);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => a && a.length > 12 ? a.slice(0, 4) + "…" + a.slice(-4) : a;
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
`;
