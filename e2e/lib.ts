// Shared harness for the devnet scripts (devnet.ts for M2, devnet-m3.ts for M3):
// output and checks, keys and a test mint, the in-process API, and a customer
// wallet that signs what the checkout hands it.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  type KeyPairSigner,
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  signature as toSignature,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token";
import { getCancelSubscriptionOverlayInstructionAsync } from "@solana/subscriptions";
import { createApp } from "@usenummo/api";
import { usdc } from "@usenummo/config";
import { createApiKey, createDb, createOrg, ensureDatabase, runMigrations } from "@usenummo/db";
import { Nummo, verifyWebhook } from "@usenummo/sdk";
import { dispatchTick, reconcileTick, type SettlementSettings, settlementTick, settingsFromEnv } from "@usenummo/settlement";
import { loadKeypair, sendAndConfirm, SolanaChain, withRateLimitRetry as rl } from "@usenummo/solana";

export const HERE = new URL(".", import.meta.url).pathname;
export const ROOT = new URL("..", import.meta.url).pathname;
export const KEYS = `${HERE}.keys`;
export const STATE_FILE = `${HERE}devnet.state.json`;
export const RPC_URL = process.env.NUMMO_TEST_RPC_URL ?? "https://api.devnet.solana.com";
export const U = 1_000_000n;
export const rpc = createSolanaRpc(RPC_URL);
// Its own database: the settlement passes below settle every org in the test environment.
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://nummo:nummo@localhost:5434/nummo_e2e";

export type Customer = { name: string; wallet: string; key: string; subscriptionId?: string; activation?: string };
export type State = { orgId: string; apiKey: string; mint: string; customers: Record<string, Customer>; aliceAnchor?: string; carolCancelAt?: string };

// ---------------------------------------------------------------- output

export const result = { failures: 0 };
export const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
export function check(cond: boolean, what: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) result.failures++;
}
export const fmt = (b: bigint) => (Number(b) / 1e6).toString();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- keys and tokens

export async function newKey(path: string): Promise<KeyPairSigner> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const bytes = new Uint8Array([...pkcs8.slice(-32), ...pub]);
  writeFileSync(path, JSON.stringify([...bytes]));
  return createKeyPairSignerFromBytes(bytes);
}

export async function sol(a: string) {
  return (await rl(() => rpc.getBalance(address(a), { commitment: "confirmed" }).send())).value;
}

export async function tokenBalance(mint: string, owner: string) {
  const [ata] = await findAssociatedTokenPda({ mint: address(mint), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  try {
    return BigInt((await rl(() => rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send())).value.amount);
  } catch {
    return 0n;
  }
}

export async function createMint(merchant: KeyPairSigner) {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const lamports = await rl(() => rpc.getMinimumBalanceForRentExemption(space).send());
  await sendAndConfirm(rpc, merchant, [
    getCreateAccountInstruction({ payer: merchant, newAccount: mint, lamports, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: merchant.address }),
  ]);
  return mint.address;
}

export async function mintTo(merchant: KeyPairSigner, mint: string, owner: string, amount: bigint) {
  const [ata] = await findAssociatedTokenPda({ mint: address(mint), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await sendAndConfirm(rpc, merchant, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: merchant, owner: address(owner), mint: address(mint) }),
    getMintToInstruction({ mint: address(mint), token: ata, mintAuthority: merchant, amount }),
  ]);
}

export async function computeUnits(sig: string) {
  const tx = await rl(() =>
    rpc.getTransaction(toSignature(sig), { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }).send(),
  );
  return tx?.meta?.computeUnitsConsumed;
}

// ---------------------------------------------------------------- harness

/** Run the CLI as a subprocess. Async, so the in-process API keeps serving it. */
export function cli(env: Record<string, string>, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [`${ROOT}packages/cli/src/main.ts`, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      for (const line of out.trim().split("\n")) console.log(`    | ${line}`);
      resolve({ code: code ?? 1, out });
    });
  });
}

export async function harness(state: Pick<State, "mint">) {
  const puller = await loadKeypair(`${KEYS}/puller.json`);
  const chain = new SolanaChain({ network: "devnet", rpcUrl: RPC_URL, puller, mint: state.mint });
  const settings: SettlementSettings = {
    ...settingsFromEnv({}),
    threshold: usdc("1"),
    retrySchedule: [20_000, 40_000, 60_000],
    boundaryMarginMs: 45_000,
    confirmWaitMs: 60_000,
    pollMs: 1_500,
  };
  await ensureDatabase(DATABASE_URL);
  const { db, close } = createDb(DATABASE_URL);
  await runMigrations(db);
  const chains = { test: chain };
  const server = serve({ fetch: createApp(db, { chains, settings }).fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  settings.publicUrl = apiUrl;

  // A local webhook receiver.
  const hooks: { body: string; sig: string | null }[] = [];
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hooks.push({ body, sig: (req.headers["x-nummo-signature"] as string) ?? null });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;

  const shutdown = async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => receiver.close(r));
    await close();
  };
  return { puller, chain, chains, settings, db, apiUrl, hooks, hookUrl, shutdown };
}

export async function checkoutAs(apiUrl: string, checkoutUrl: string, customer: KeyPairSigner) {
  const id = checkoutUrl.split("/").pop()!;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`${apiUrl}/checkout/${id}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = (await r.json()) as Record<string, any>;
    if (!r.ok) throw new Error(`${path}: ${j.error?.message ?? r.status}`);
    return j;
  };
  const session = await call("/session");
  const { transaction, createsAuthority } = await call("/transaction", { wallet: customer.address });
  // What a browser wallet does: sign the bytes it was given, without broadcasting.
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const signed = await partiallySignTransaction([customer.keyPair], tx as Parameters<typeof partiallySignTransaction>[1]);
  const done = await call("/submit", { signedTransaction: getBase64EncodedWireTransaction(signed) });
  return { session, done, createsAuthority };
}

