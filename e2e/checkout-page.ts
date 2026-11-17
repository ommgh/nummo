// Serve a live devnet checkout for a fresh wallet, to drive the hosted page in a browser.
//
//   node e2e/checkout-page.ts
//
// Prints the checkout URL, and the customer's address and secret key for a test
// wallet. Keeps the API running (port 8790) until interrupted. Uses its own test
// mint, so it never touches the balances `e2e/devnet.ts` checks.

import { mkdirSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import {
  type KeyPairSigner,
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
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
import { createApp } from "@usenummo/api";
import { toDocument } from "@usenummo/config";
import { createApiKey, createDb, createOrg, ensureDatabase, runMigrations } from "@usenummo/db";
import { Nummo } from "@usenummo/sdk";
import { planIdSeed, settingsFromEnv } from "@usenummo/settlement";
import { loadKeypair, publishPlan, sendAndConfirm, SolanaChain, withRateLimitRetry as rl } from "@usenummo/solana";
import config from "./nummo.config.ts";

const HERE = new URL(".", import.meta.url).pathname;
const RPC_URL = process.env.NUMMO_TEST_RPC_URL ?? "https://api.devnet.solana.com";
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://nummo:nummo@localhost:5434/nummo_e2e";
const PORT = Number(process.env.PORT ?? 8790);
const rpc = createSolanaRpc(RPC_URL);

async function newKey(): Promise<{ signer: KeyPairSigner; bytes: number[] }> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const bytes = [...pkcs8.slice(-32), ...pub];
  return { signer: await createKeyPairSignerFromBytes(new Uint8Array(bytes)), bytes };
}

const merchant = await loadKeypair(`${HERE}.keys/merchant.json`);
const puller = await loadKeypair(`${HERE}.keys/puller.json`);

// A fresh test mint and a customer wallet holding 10 of it, and no SOL.
const mint = await generateKeyPairSigner();
const space = BigInt(getMintSize());
await sendAndConfirm(rpc, merchant, [
  getCreateAccountInstruction({
    payer: merchant,
    newAccount: mint,
    lamports: await rl(() => rpc.getMinimumBalanceForRentExemption(space).send()),
    space,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  }),
  getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: merchant.address }),
]);
const customer = await newKey();
const [ata] = await findAssociatedTokenPda({ mint: mint.address, owner: customer.signer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
await sendAndConfirm(rpc, merchant, [
  await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: merchant, owner: customer.signer.address, mint: mint.address }),
  getMintToInstruction({ mint: mint.address, token: ata, mintAuthority: merchant, amount: 10_000_000n }),
]);

const chain = new SolanaChain({ network: "devnet", rpcUrl: RPC_URL, puller, mint: mint.address });
const settings = { ...settingsFromEnv({}), publicUrl: `http://localhost:${PORT}` };
await ensureDatabase(DATABASE_URL);
const { db } = createDb(DATABASE_URL);
await runMigrations(db);
const orgId = await createOrg(db, "Demo AI (checkout page test)");
const { key } = await createApiKey(db, orgId, "test");
serve({ fetch: createApp(db, { chains: { test: chain }, settings }).fetch, port: PORT });

const nummo = new Nummo({ secretKey: key, baseUrl: settings.publicUrl, timeoutMs: 120_000 });
await nummo.config.push(toDocument(config));
const terms = (await nummo.plans.list()).versions.find((v) => v.planId === "pro")!.onchainTerms!;
const { planAddress } = await publishPlan(rpc, {
  merchant,
  planId: planIdSeed({ orgId, env: "test" }, "pro", 1),
  mint: mint.address,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
  amount: BigInt(terms.amount),
  periodHours: terms.periodHours,
  puller: puller.address,
  metadataUri: terms.metadataUri,
});
await nummo.plans.publish("pro", 1, planAddress);
const a = await nummo.attach({ customerId: "page_test", planId: "pro", successUrl: `${settings.publicUrl}/health` });

mkdirSync(`${HERE}.keys`, { recursive: true });
const out = { checkoutUrl: a.checkoutUrl, wallet: customer.signer.address, secretKey: customer.bytes, apiKey: key, mint: mint.address };
writeFileSync(`${HERE}.keys/checkout-page.json`, JSON.stringify(out));
console.log(JSON.stringify({ checkoutUrl: a.checkoutUrl, wallet: customer.signer.address, address: address(customer.signer.address) }));
console.log("ready");
