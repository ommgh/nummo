/**
 * Just enough of the Wallet Standard to connect a Solana wallet (Phantom,
 * Solflare, Backpack) and sign one transaction, without a wallet adapter
 * library. Same approach as the hosted checkout's page-kit.
 */

type WalletAccount = { address: string };
export type StandardWallet = {
  name: string;
  icon?: string;
  accounts: WalletAccount[];
  features: Record<string, any>;
};

const wallets: StandardWallet[] = [];
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  const registry = {
    register: (...ws: StandardWallet[]) => {
      for (const w of ws) if (!wallets.includes(w)) wallets.push(w);
      listeners.forEach((f) => f());
      return () => {};
    },
  };
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    try {
      (e as CustomEvent).detail(registry);
    } catch {
      // A broken wallet extension should not break the page.
    }
  });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: registry }));
}

const usable = (w: StandardWallet) => w.features["standard:connect"] && w.features["solana:signTransaction"];

export function listWallets(): StandardWallet[] {
  start();
  return wallets.filter(usable);
}

export function onWalletsChange(f: () => void) {
  start();
  listeners.add(f);
  return () => listeners.delete(f);
}

export async function connect(w: StandardWallet): Promise<WalletAccount> {
  const { accounts } = await w.features["standard:connect"].connect();
  const account = accounts?.[0] ?? w.accounts[0];
  if (!account) throw new Error("The wallet did not share an account.");
  return account;
}

const b64ToBytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function signTransaction(w: StandardWallet, account: WalletAccount, transaction: string, network: string) {
  const chain = network === "mainnet" ? "solana:mainnet" : "solana:devnet";
  const [out] = await w.features["solana:signTransaction"].signTransaction({ account, transaction: b64ToBytes(transaction), chain });
  return bytesToB64(out.signedTransaction);
}
