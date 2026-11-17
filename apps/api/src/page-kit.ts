/**
 * What the hosted pages share: tokens, base styles, and the Wallet Standard
 * client. Plain CSS and JS strings, no bundler (see checkout-page.ts).
 */

export const BASE_CSS = /* css */ `
  :root {
    --bg: #f6f5f2; --card: #ffffff; --fg: #1d1b18; --muted: #6f6a62; --line: #e4e1db;
    --accent: #5b3cc4; --accent-fg: #ffffff; --ok: #1f7a4d; --warn: #9a6100; --bad: #b42318; --chip: #efecf9;
    --track: #ece9e3;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151413; --card: #1e1d1b; --fg: #f2f0ec; --muted: #a39e95; --line: #34322e;
      --accent: #a48cf0; --accent-fg: #151413; --ok: #5cc493; --warn: #e0a84a; --bad: #f2877c; --chip: #2a2638; --track: #2c2a27; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  .muted { color: var(--muted); }
  .merchant { color: var(--muted); font-size: 13px; letter-spacing: .02em; }
  .chip { display: inline-block; background: var(--chip); color: var(--accent); border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
  .chip.ok { color: var(--ok); } .chip.warn { color: var(--warn); } .chip.bad { color: var(--bad); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 10px 16px; margin: 16px 0; }
  dt { color: var(--muted); } dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; overflow-wrap: anywhere; }
  .note { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  button, .button { display: inline-flex; align-items: center; gap: 10px; justify-content: center; padding: 10px 14px; border-radius: 10px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
  button.secondary, .button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
  button.secondary:hover { border-color: var(--accent); }
  button.danger { background: transparent; color: var(--bad); border-color: var(--line); }
  button.wallet { width: 100%; background: transparent; color: var(--fg); border-color: var(--line); justify-content: flex-start; }
  button.wallet:hover { border-color: var(--accent); }
  button:disabled { opacity: .55; cursor: progress; }
  button img { width: 22px; height: 22px; border-radius: 6px; }
  input, select { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; }
  .status { margin-top: 12px; min-height: 1.5em; overflow-wrap: anywhere; }
  .status.bad { color: var(--bad); } .status.ok { color: var(--ok); }
  a { color: var(--accent); }
  .foot { color: var(--muted); font-size: 12px; text-align: center; margin-top: 16px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
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
