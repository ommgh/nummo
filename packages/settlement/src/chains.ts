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
 *   NUMMO_E_PULLER_KEY   path to a keypair file, or the JSON byte array itself (required to enable E)
 *   NUMMO_E_RPC_URL      RPC endpoint (defaults to the public cluster)
 *   NUMMO_E_MINT         token mint (defaults to USDC on that cluster)
 *   NUMMO_PRIORITY_FEE   micro-lamports per compute unit (default 0)
 */
export async function chainsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Chains> {
  const chains: Chains = {};
  for (const e of ["test", "live"] as const) {
    const key = env[`NUMMO_${e.toUpperCase()}_PULLER_KEY`];
    if (!key) continue;
    const network = NETWORK[e];
    chains[e] = new SolanaChain({
      network,
      rpcUrl: env[`NUMMO_${e.toUpperCase()}_RPC_URL`] ?? DEFAULT_RPC[e],
      puller: await loadKeypair(key),
      mint: env[`NUMMO_${e.toUpperCase()}_MINT`] ?? USDC_MINT[network],
      priorityFeeMicroLamports: BigInt(env.NUMMO_PRIORITY_FEE ?? "0"),
    });
  }
  return chains;
}
