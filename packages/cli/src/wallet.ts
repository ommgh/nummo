/**
 * `nummo wallet new` and `nummo wallet balance`: enough wallet handling for the
 * quickstart without installing the Solana CLI. Keypair files use the Solana
 * CLI format (a JSON array of 64 bytes: secret seed then public key), so they
 * work with `solana`, `nummo plans publish --keypair`, and the API's
 * NUMMO_TEST_PULLER_KEY.
 */

import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { address, createSolanaRpc, getAddressDecoder } from "@solana/kit";
import { findAssociatedTokenPda, loadKeypair, USDC_MINT, withRateLimitRetry } from "@usenummo/solana";

export function newKeypairFile(path: string, force = false): string {
  if (existsSync(path) && !force) throw new Error(`${path} exists; pass --force to overwrite it`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  writeFileSync(path, `${JSON.stringify([...seed, ...pub])}\n`, { mode: 0o600 });
  return getAddressDecoder().decode(pub);
}

export async function addressOf(target: string): Promise<string> {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target) && !existsSync(target)) return target;
  return (await loadKeypair(target)).address;
}

export async function balances(owner: string, network: "devnet" | "mainnet", rpcUrl?: string) {
  const rpc = createSolanaRpc(rpcUrl ?? (network === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com"));
  const mint = USDC_MINT[network];
  const { value: lamports } = await withRateLimitRetry(() => rpc.getBalance(address(owner), { commitment: "confirmed" }).send());
  const mintInfo = await withRateLimitRetry(() => rpc.getAccountInfo(address(mint), { encoding: "base64" }).send());
  const [ata] = await findAssociatedTokenPda({ mint: address(mint), owner: address(owner), tokenProgram: mintInfo.value!.owner });
  let usdc: string | null = null;
  try {
    const { value } = await withRateLimitRetry(() => rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send());
    usdc = value.uiAmountString ?? null;
  } catch {
    usdc = null;
  }
  return { sol: Number(lamports) / 1e9, usdc };
}
