/**
 * `Chain` over Solana RPC, using @solana/kit and the Subscriptions program SDK.
 * Spikes S1 and S2 (spikes/README.md) confirmed the transaction shapes used here.
 */

import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type Transaction,
  address,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionWithinSizeLimit,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSolanaError,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type SignatureBytes,
  verifySignature,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  PlanStatus,
  UNKNOWN_INIT_ID,
  ZERO_ADDRESS,
  fetchMaybePlan,
  fetchMaybeSubscriptionAuthority,
  fetchMaybeSubscriptionDelegation,
  findPlanPda,
  findSubscriptionAuthorityPda,
  findSubscriptionDelegationPda,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getSubscribeOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
} from "@solana/subscriptions";
import { classify } from "./errors.ts";
import {
  ActivationRejected,
  type ActivationInput,
  type BuiltActivation,
  type Chain,
  type Network,
  type OnchainAuthority,
  type OnchainPlan,
  type OnchainSubscription,
  type PreparedTx,
  type PullInput,
  type SendResult,
  type TxStatus,
} from "./types.ts";

export type SolanaChainOptions = {
  rpcUrl: string;
  network: Network;
  puller: KeyPairSigner;
  mint: string;
  /** Priority fee in micro-lamports per compute unit. Devnet works without; mainnet should set one. */
  priorityFeeMicroLamports?: bigint;
};

/**
 * Compute unit limits, about 3x what devnet measured on 2026-11-17 (activation
 * 20k to 36k with a new authority, a pull about 6k). A tight limit keeps the
 * priority fee small, since it is paid per unit requested.
 */
const CU_ACTIVATION = 100_000;
const CU_PULL = 20_000;

/** The public devnet RPC rate-limits with HTTP 429. Retry those with backoff; never retry anything else. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { context?: { statusCode?: number }; message?: string };
      const is429 = err?.context?.statusCode === 429 || /\b429\b/.test(String(err?.message));
      if (!is429 || attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 750 * 2 ** Math.min(attempt, 4)));
    }
  }
}
const rl = withRateLimitRetry;

const b64 = { toBytes: (s: string) => getBase64Encoder().encode(s), fromBytes: (b: Uint8Array) => getBase64Decoder().decode(b) };

export class SolanaChain implements Chain {
  readonly network: Network;
  readonly pullerAddress: string;
  readonly mint: string;
  readonly rpc: Rpc<SolanaRpcApi>;
  private readonly puller: KeyPairSigner;
  private readonly priorityFee: bigint;
  private tokenProgram: Address | null = null;

  constructor(opts: SolanaChainOptions) {
    this.network = opts.network;
    this.puller = opts.puller;
    this.pullerAddress = opts.puller.address;
    this.mint = opts.mint;
    this.rpc = createSolanaRpc(opts.rpcUrl);
    this.priorityFee = opts.priorityFeeMicroLamports ?? 0n;
  }

  /** The token program that owns the mint (SPL Token for USDC; Token-2022 for some others). */
  private async getTokenProgram(): Promise<Address> {
    if (this.tokenProgram) return this.tokenProgram;
    const { value } = await rl(() => this.rpc.getAccountInfo(address(this.mint), { encoding: "base64" }).send());
    if (!value) throw new Error(`mint ${this.mint} does not exist on ${this.network}`);
    this.tokenProgram = value.owner;
    return this.tokenProgram;
  }

  private async ata(owner: string): Promise<Address> {
    const [a] = await findAssociatedTokenPda({ mint: address(this.mint), owner: address(owner), tokenProgram: await this.getTokenProgram() });
    return a;
  }

  private computeBudget(units: number): Instruction[] {
    const ixs: Instruction[] = [getSetComputeUnitLimitInstruction({ units })];
    if (this.priorityFee > 0n) ixs.push(getSetComputeUnitPriceInstruction({ microLamports: this.priorityFee }));
    return ixs;
  }

  // ---------------------------------------------------------------- reads

  async getPlan(planAddress: string): Promise<OnchainPlan | null> {
    const acc = await rl(() => fetchMaybePlan(this.rpc, address(planAddress), { commitment: "confirmed" }));
    if (!acc.exists) return null;
    const p = acc.data;
    return {
      address: planAddress,
      owner: p.owner,
      planId: p.data.planId,
      mint: p.data.mint,
      amount: p.data.terms.amount,
      periodHours: Number(p.data.terms.periodHours),
      createdAt: p.data.terms.createdAt,
      endTs: p.data.endTs,
      status: p.status === PlanStatus.Active ? "active" : "sunset",
      pullers: p.data.pullers.filter((a) => a !== ZERO_ADDRESS),
      destinations: p.data.destinations.filter((a) => a !== ZERO_ADDRESS),
    };
  }

  async getSubscription(subscriptionAddress: string): Promise<OnchainSubscription | null> {
    const acc = await rl(() => fetchMaybeSubscriptionDelegation(this.rpc, address(subscriptionAddress), { commitment: "confirmed" }));
    if (!acc.exists) return null;
    const s = acc.data;
    return {
      address: subscriptionAddress,
      subscriber: s.header.delegator,
      plan: s.header.delegatee,
      payer: s.header.payer,
      initId: s.header.initId,
      amount: s.terms.amount,
      periodHours: Number(s.terms.periodHours),
      amountPulledInPeriod: s.amountPulledInPeriod,
      currentPeriodStart: new Date(Number(s.currentPeriodStartTs) * 1000),
      expiresAt: s.expiresAtTs === 0n ? null : new Date(Number(s.expiresAtTs) * 1000),
    };
  }

  async getAuthority(owner: string): Promise<OnchainAuthority | null> {
    const [pda] = await findSubscriptionAuthorityPda({ user: address(owner), tokenMint: address(this.mint) });
    const acc = await rl(() => fetchMaybeSubscriptionAuthority(this.rpc, pda, { commitment: "confirmed" }));
    return acc.exists ? { address: pda, initId: acc.data.initId } : null;
  }

  async getTokenBalance(owner: string): Promise<bigint | null> {
    const ata = await this.ata(owner);
    try {
      const { value } = await rl(() => this.rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send());
      return BigInt(value.amount);
    } catch (e) {
      if (/could not find account|Invalid param/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  async findPlanAddress(owner: string, planId: bigint): Promise<string> {
    const [pda] = await findPlanPda({ owner: address(owner), planId });
    return pda;
  }

  async findSubscriptionAddress(planAddress: string, subscriber: string): Promise<string> {
    const [pda] = await findSubscriptionDelegationPda({ planPda: address(planAddress), subscriber: address(subscriber) });
    return pda;
  }

  async getBlockHeight(): Promise<bigint> {
    return rl(() => this.rpc.getBlockHeight({ commitment: "confirmed" }).send());
  }

  async getStatuses(signatures: string[]): Promise<TxStatus[]> {
    if (signatures.length === 0) return [];
    const { value } = await rl(() =>
      this.rpc.getSignatureStatuses(signatures.map((s) => signature(s)), { searchTransactionHistory: true }).send(),
    );
    return value.map((s): TxStatus => {
      if (!s) return { state: "unknown" };
      if (s.err) return { state: "failed", error: classify(s.err) };
      if (s.confirmationStatus === "finalized") return { state: "finalized" };
      if (s.confirmationStatus === "confirmed") return { state: "confirmed" };
      return { state: "pending" };
    });
  }

  // ---------------------------------------------------------------- writes

  async buildActivation(input: ActivationInput): Promise<BuiltActivation> {
    const { plan } = input;
    const tokenProgram = await this.getTokenProgram();
    const subscriber = createNoopSigner(address(input.subscriber));
    const authority = await this.getAuthority(input.subscriber);
    const ixs: Instruction[] = this.computeBudget(CU_ACTIVATION);

    if (!authority) {
      ixs.push(
        await getInitSubscriptionAuthorityOverlayInstructionAsync({
          owner: subscriber,
          payer: this.puller,
          tokenMint: address(this.mint),
          userAta: await this.ata(input.subscriber),
          tokenProgram,
        }),
      );
    }
    ixs.push(
      await getSubscribeOverlayInstructionAsync({
        subscriber,
        payer: this.puller,
        merchant: address(plan.owner),
        planId: plan.planId,
        tokenMint: address(this.mint),
        expectedAmount: plan.amount,
        expectedPeriodHours: plan.periodHours,
        expectedCreatedAt: plan.createdAt,
        // A new wallet's authority is created in this same transaction (doc 03, activation step 3).
        expectedSubscriptionAuthorityInitId: authority ? authority.initId : UNKNOWN_INIT_ID,
      }),
    );
    if (input.firstPull > 0n) {
      ixs.push(
        await getTransferSubscriptionOverlayInstructionAsync({
          caller: this.puller,
          delegator: address(input.subscriber),
          planPda: address(plan.address),
          subscriptionPda: address(await this.findSubscriptionAddress(plan.address, input.subscriber)),
          receiverAta: await this.ata(plan.owner),
          tokenMint: address(this.mint),
          tokenProgram,
          amount: input.firstPull,
        }),
      );
    }

    const { value: bh } = await rl(() => this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.puller, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = compileTransaction(message);
    assertIsTransactionWithinSizeLimit(tx);
    return {
      transaction: getBase64EncodedWireTransaction(tx),
      message: b64.fromBytes(tx.messageBytes as unknown as Uint8Array),
      lastValidBlockHeight: bh.lastValidBlockHeight,
      createsAuthority: !authority,
    };
  }

  async cosignActivation(signedTransaction: string, expectedMessage: string, subscriber: string, lastValidBlockHeight: bigint): Promise<PreparedTx> {
    let tx: Transaction;
    try {
      tx = getTransactionDecoder().decode(b64.toBytes(signedTransaction));
    } catch {
      throw new ActivationRejected("the signed transaction could not be decoded");
    }
    // Byte-for-byte: the wallet may sign, but must not add, drop or change instructions (doc 02, security basics).
    if (b64.fromBytes(tx.messageBytes as unknown as Uint8Array) !== expectedMessage) {
      throw new ActivationRejected("the signed transaction is not the one we built");
    }
    const sig = tx.signatures[address(subscriber)] as SignatureBytes | null | undefined;
    if (!sig) throw new ActivationRejected("the transaction is not signed by the subscriber's wallet");
    const ok = await verifySignature(await getPublicKeyFromAddress(address(subscriber)), sig, tx.messageBytes);
    if (!ok) throw new ActivationRejected("the subscriber's signature is not valid");

    const full = await partiallySignTransaction([this.puller.keyPair], tx as Parameters<typeof partiallySignTransaction>[1]);
    assertIsFullySignedTransaction(full);
    return {
      signature: getSignatureFromTransaction(full),
      wire: getBase64EncodedWireTransaction(full),
      lastValidBlockHeight,
    };
  }

  async preparePull(input: PullInput): Promise<PreparedTx> {
    const tokenProgram = await this.getTokenProgram();
    const ix = await getTransferSubscriptionOverlayInstructionAsync({
      caller: this.puller,
      delegator: address(input.subscriber),
      planPda: address(input.plan.address),
      subscriptionPda: address(input.subscriptionAddress),
      receiverAta: await this.ata(input.plan.owner),
      tokenMint: address(this.mint),
      tokenProgram,
      amount: input.amount,
    });
    const { value: bh } = await rl(() => this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.puller, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions([...this.computeBudget(CU_PULL), ix], m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    return { signature: getSignatureFromTransaction(signed), wire: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: bh.lastValidBlockHeight };
  }

  async send(tx: PreparedTx): Promise<SendResult> {
    try {
      await rl(() =>
        this.rpc
          .sendTransaction(tx.wire as Parameters<typeof this.rpc.sendTransaction>[0], { encoding: "base64", preflightCommitment: "confirmed" })
          .send(),
      );
      return { ok: true };
    } catch (e) {
      // A preflight failure was never forwarded to a leader, so it cannot land later.
      const definite = isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE);
      return { ok: false, definite, error: classify(e) };
    }
  }
}

/** Default token mints (doc 03, "Tokens and networks"). */
export const USDC_MINT: Record<"devnet" | "mainnet", string> = {
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

export { TOKEN_PROGRAM_ADDRESS };
