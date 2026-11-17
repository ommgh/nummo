/**
 * What the billing layer needs from the chain. `SolanaChain` implements it over
 * RPC; `FakeChain` (in ./fake-chain.ts) implements it in memory for tests,
 * following the same program rules.
 *
 * Addresses and signatures are base58 strings. Amounts are token base units.
 */

export type Network = "devnet" | "mainnet" | "localnet" | "fake";

export type OnchainPlan = {
  address: string;
  owner: string;
  planId: bigint;
  mint: string;
  /** The most that may be pulled per period (decision D3: the plan version's ceiling). */
  amount: bigint;
  periodHours: number;
  /** Plan creation time in unix seconds; the subscriber's consent snapshot includes it. */
  createdAt: bigint;
  /** Unix seconds after which pulls fail, or 0 for no end. */
  endTs: bigint;
  status: "active" | "sunset";
  pullers: string[];
  destinations: string[];
};

export type OnchainSubscription = {
  address: string;
  subscriber: string;
  /** The plan account this subscription belongs to. */
  plan: string;
  /** Who paid rent for the record. */
  payer: string;
  /** Must equal the subscriber's Subscription Authority init id, or the record is abandoned. */
  initId: bigint;
  amount: bigint;
  periodHours: number;
  amountPulledInPeriod: bigint;
  /** Anchored to the subscribe time; advances by whole periods on the first pull of a new period. */
  currentPeriodStart: Date;
  /** Set once the subscriber cancels: the end of the period they cancelled in. */
  expiresAt: Date | null;
};

export type OnchainAuthority = { address: string; initId: bigint };

/** Why a transaction failed, in the terms the billing layer acts on (doc 03, "When a pull fails"). */
export type ChainErrorKind =
  | "insufficient_funds"
  | "account_frozen"
  | "ceiling_reached"
  | "subscription_cancelled"
  | "plan_expired"
  | "stale_authority"
  | "unauthorized"
  | "not_found"
  /** Our side, not the customer's: fee payer out of SOL, blockhash not found, RPC trouble. Retry. */
  | "transient"
  | "unknown";

export type ChainError = { kind: ChainErrorKind; code: number | null; message: string };

export type TxStatus =
  | { state: "pending" }
  | { state: "confirmed" | "finalized" }
  | { state: "failed"; error: ChainError }
  /** The cluster has no record of the signature. Combined with block height, this tells us a tx expired. */
  | { state: "unknown" };

/** A fully signed transaction, ready to broadcast. Record `signature` before sending it. */
export type PreparedTx = { signature: string; wire: string; lastValidBlockHeight: bigint };

export type SendResult =
  | { ok: true }
  /**
   * `definite: true` means the cluster rejected it in preflight and it was not
   * forwarded, so it cannot land. Otherwise it may still land: wait for expiry.
   */
  | { ok: false; definite: boolean; error: ChainError };

export type ActivationInput = {
  plan: OnchainPlan;
  subscriber: string;
  /** First pull inside the activation (the base fee). 0 skips the pull. */
  firstPull: bigint;
};

export type BuiltActivation = {
  /** Unsigned wire transaction, base64, for the wallet to sign. */
  transaction: string;
  /** The message bytes, base64. The signed copy must carry exactly these. */
  message: string;
  lastValidBlockHeight: bigint;
  /** True when this wallet had no Subscription Authority and the transaction creates one. */
  createsAuthority: boolean;
};

export type PullInput = {
  plan: Pick<OnchainPlan, "address" | "owner" | "mint">;
  subscriptionAddress: string;
  subscriber: string;
  amount: bigint;
};

export interface Chain {
  readonly network: Network;
  /** The hot wallet that signs pulls and pays fees and rent. */
  readonly pullerAddress: string;
  /** The token mint this deployment settles in for this environment. */
  readonly mint: string;

  getPlan(address: string): Promise<OnchainPlan | null>;
  getSubscription(address: string): Promise<OnchainSubscription | null>;
  /** The subscriber's Subscription Authority for `mint`, if any. */
  getAuthority(owner: string): Promise<OnchainAuthority | null>;
  /** Balance of `owner`'s associated token account for `mint`, or null if it does not exist. */
  getTokenBalance(owner: string): Promise<bigint | null>;
  findPlanAddress(owner: string, planId: bigint): Promise<string>;
  findSubscriptionAddress(planAddress: string, subscriber: string): Promise<string>;

  getBlockHeight(): Promise<bigint>;
  getStatuses(signatures: string[]): Promise<TxStatus[]>;

  /** Build the one-signature activation: [init authority] + subscribe + first pull, puller as fee payer. */
  buildActivation(input: ActivationInput): Promise<BuiltActivation>;
  /**
   * Check that a wallet-signed activation carries exactly `expectedMessage` and a
   * valid signature from `subscriber`, then add the puller's signature.
   * Throws ActivationRejected otherwise.
   */
  cosignActivation(signedTransaction: string, expectedMessage: string, subscriber: string, lastValidBlockHeight: bigint): Promise<PreparedTx>;
  preparePull(input: PullInput): Promise<PreparedTx>;
  send(tx: PreparedTx): Promise<SendResult>;
}

export class ActivationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivationRejected";
  }
}
