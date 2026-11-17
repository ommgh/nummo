/**
 * One chain per environment: `test` settles on devnet, `live` on mainnet
 * (doc 02, data model). The puller key comes from the environment, never the
 * database (doc 02, security basics).
 */

import type { Env } from "@usenummo/db";
import { type Chain, loadKeypair, SolanaChain, USDC_MINT } from "@usenummo/solana";

export type Chains = Partial<Record<Env, Chain>>;

const NETWORK = { test: "devnet", live: "mainnet" } as const;
const DEFAULT_RPC = { test: "https://api.devnet.solana.com", live: "https://api.mainnet-beta.solana.com" } as const;

/**
 * Reads, per environment E in TEST and LIVE:
 *   NUMMO_E_PULLER_KEY     path to a keypair file, or the JSON byte array itself (required to enable E)
 *   NUMMO_E_RPC_URL        RPC endpoint (defaults to the public cluster)
 *   NUMMO_E_MINT           token mint (defaults to USDC on that cluster)
 *   NUMMO_E_PRIORITY_FEE   micro-lamports per compute unit; falls back to NUMMO_PRIORITY_FEE,
 *                          then 0 on devnet and 10,000 on mainnet
 *
 * Mainnet settles real money, so the live chain refuses a mint other than USDC
 * unless NUMMO_LIVE_ALLOW_MINT names it too, and warns about the public RPC.
 */
export async function chainsFromEnv(env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = console.warn): Promise<Chains> {
  const chains: Chains = {};
  for (const e of ["test", "live"] as const) {
    const E = e.toUpperCase();
    const key = env[`NUMMO_${E}_PULLER_KEY`];
    if (!key) continue;
    const network = NETWORK[e];
    const rpcUrl = env[`NUMMO_${E}_RPC_URL`] ?? DEFAULT_RPC[e];
    const mint = env[`NUMMO_${E}_MINT`] ?? USDC_MINT[network];
    const fee = env[`NUMMO_${E}_PRIORITY_FEE`] ?? env.NUMMO_PRIORITY_FEE ?? (e === "live" ? "10000" : "0");
    if (e === "live") {
      if (mint !== USDC_MINT.mainnet && env.NUMMO_LIVE_ALLOW_MINT !== mint) {
        throw new Error(`NUMMO_LIVE_MINT is ${mint}, not mainnet USDC; set NUMMO_LIVE_ALLOW_MINT to the same value if that is intended`);
      }
      if (rpcUrl === DEFAULT_RPC.live) warn("live: using the public mainnet RPC, which rate-limits; set NUMMO_LIVE_RPC_URL to a provider's endpoint");
      if (BigInt(fee) === 0n) warn("live: no priority fee; pulls may land slowly when the network is busy (NUMMO_LIVE_PRIORITY_FEE)");
    }
    chains[e] = new SolanaChain({ network, rpcUrl, puller: await loadKeypair(key), mint, priorityFeeMicroLamports: BigInt(fee) });
  }
  return chains;
}
