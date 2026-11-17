/**
 * Things only the merchant's own wallet can sign: publishing a plan. Used by
 * `nummo plans publish` and the devnet scripts, never by the API or worker,
 * which only hold the puller key (doc 03, "Key custody").
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { findPlanPda, getCreatePlanOverlayInstructionAsync, METADATA_URI_LEN } from "@solana/subscriptions";
import { classify } from "./errors.ts";
import { withRateLimitRetry as rl } from "./solana-chain.ts";

/**
 * Load a keypair from a Solana CLI style file (a JSON array of 64 bytes) or
 * from that JSON array given inline.
 */
export async function loadKeypair(source: string): Promise<KeyPairSigner> {
  const text = source.trim().startsWith("[") ? source : readFileSync(source, "utf8");
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(text)));
}

/**
 * A deterministic u64 plan id for a plan version, so publishing is idempotent:
 * a rerun after a crash finds the plan it already created at the same address.
 */
export function onchainPlanIdFor(seed: string): bigint {
  const h = createHash("sha256").update(seed).digest();
  return h.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
}

/** Sign with every signer in the instructions, send, and wait for `confirmed`. */
export async function sendAndConfirm(rpc: Rpc<SolanaRpcApi>, feePayer: KeyPairSigner, ixs: Instruction[], timeoutMs = 60_000): Promise<string> {
  const { value: bh } = await rl(() => rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(signed);
  await rl(() =>
    rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send(),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const { value } = await rl(() => rpc.getSignatureStatuses([sig]).send());
    const s = value[0];
    if (s?.err) throw new Error(`transaction ${sig} failed: ${classify(s.err).message}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`transaction ${sig} was not confirmed within ${timeoutMs / 1000}s`);
}

export type PublishPlanInput = {
  merchant: KeyPairSigner;
  planId: bigint;
  mint: string;
  tokenProgram: string;
  /** The plan version's ceiling, in base units. */
  amount: bigint;
  periodHours: number;
  /** The hot wallet that collects; the merchant (owner) can always pull too. */
  puller: string;
  metadataUri: string;
};

/**
 * Create the on-chain plan for a plan version, plus the merchant's receiving
 * token account (doc 03 gotcha: it must exist before the first pull). Funds can
 * only go to the merchant: the destination list holds the merchant alone.
 */
export async function publishPlan(rpc: Rpc<SolanaRpcApi>, input: PublishPlanInput): Promise<{ planAddress: string; signature: string | null }> {
  const [planPda] = await findPlanPda({ owner: input.merchant.address, planId: input.planId });
  const existing = await rl(() => rpc.getAccountInfo(planPda, { encoding: "base64" }).send());
  if (existing.value) return { planAddress: planPda, signature: null };
  if (new TextEncoder().encode(input.metadataUri).length > METADATA_URI_LEN) {
    throw new Error(`metadata URI is longer than ${METADATA_URI_LEN} bytes`);
  }
  const ixs: Instruction[] = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: input.merchant,
      owner: input.merchant.address,
      mint: address(input.mint),
      tokenProgram: address(input.tokenProgram),
    }),
    await getCreatePlanOverlayInstructionAsync({
      owner: input.merchant,
      planId: input.planId,
      mint: address(input.mint),
      amount: input.amount,
      periodHours: input.periodHours,
      endTs: 0n,
      destinations: [input.merchant.address],
      pullers: [address(input.puller)],
      metadataUri: input.metadataUri,
      tokenProgram: address(input.tokenProgram),
    }),
  ];
  const signature = await sendAndConfirm(rpc, input.merchant, ixs);
  return { planAddress: planPda, signature };
}
