/**
 * An in-memory `Chain` for tests. It follows the Subscriptions program's rules
 * as confirmed in spikes S1 and S2 and the program source (spikes/README.md):
 *
 * - a pull is rejected with 400 once the period total would pass the plan amount;
 * - periods are anchored at subscribe time and advance in whole steps on the
 *   first pull of a new period, which resets the counter;
 * - a cancelled subscription can be pulled until the end of the period it was
 *   cancelled in, then fails with 508;
 * - a closed or re-created Subscription Authority makes the record stale (136);
 * - the token transfer fails with SPL Token error 1 when the balance is short.
 *
 * Time is controlled by the test (`advance`, `setNow`), and sends can be made to
 * drop, time out, or stay pending, to exercise safe resend.
 */

import { randomBytes } from "node:crypto";
import { chainError, ERROR_CODES, kindForCode } from "./errors.ts";
import {
  ActivationRejected,
  type ActivationInput,
  type BuiltActivation,
  type BuiltTx,
  type TransferInput,
  type Chain,
  type ChainError,
  type OnchainAuthority,
  type OnchainPlan,
  type OnchainSubscription,
  type PreparedTx,
  type PullInput,
  type SendResult,
  type TxStatus,
} from "./types.ts";

const HOUR = 3_600_000;
/** Roughly 400 ms slots; a blockhash stays valid for 150 blocks (about a minute). */
const SLOT_MS = 400;
const BLOCKHASH_LIFETIME = 150n;

type Op =
  | {
      kind: "activation";
      plan: string;
      subscriber: string;
      initAuthority: boolean;
      expectedInitId: bigint | null;
      firstPull: string;
      /** A plan change also cancels the subscriber's subscription to this plan. */
      cancelPlan: string | null;
    }
  | { kind: "pull"; plan: string; subscription: string; subscriber: string; amount: string }
  | { kind: "cancel"; plan: string; subscriber: string }
  | { kind: "resume"; plan: string; subscriber: string; expiresAt: number }
  | { kind: "transfer"; from: string; to: string; amount: string; reference: string }
  | { kind: "createPlan"; owner: string; planId: string; amount: string; periodHours: number };

type Wire = { message: string; signers: string[] };

/** What the next `send` does. "ok" executes at once, like a send that confirms within the test step. */
export type SendMode = "ok" | "drop" | "timeout_lands" | "timeout_drops" | "pending";

const enc = (v: unknown) => Buffer.from(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).toString("base64");
const dec = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;

function fakeAddress(prefix: string) {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

export class FakeChain implements Chain {
  readonly network = "fake" as const;
  readonly pullerAddress: string;
  readonly mint: string;

  private clock: number;
  private readonly epoch: number;
  private nextInitId = 1n;
  readonly plans = new Map<string, OnchainPlan>();
  readonly subscriptions = new Map<string, OnchainSubscription>();
  readonly authorities = new Map<string, OnchainAuthority>();
  /** Token balances by owner. An owner with no entry has no token account. */
  readonly balances = new Map<string, bigint>();
  readonly frozen = new Set<string>();
  private readonly txs = new Map<string, { state: "pending" | "confirmed" | "finalized" | "failed"; error?: ChainError; op: Op }>();
  private readonly pendingOps: { signature: string; op: Op }[] = [];
  /** Queue of behaviours for upcoming sends; empty means "ok". */
  readonly sendModes: SendMode[] = [];
  /** Every pull that moved money, for assertions. */
  readonly transfers: { from: string; to: string; amount: bigint; signature: string; at: Date }[] = [];

  constructor(opts: { now?: Date; puller?: string; mint?: string } = {}) {
    this.clock = (opts.now ?? new Date("2026-11-17T00:00:00Z")).getTime();
    this.epoch = this.clock;
    this.pullerAddress = opts.puller ?? fakeAddress("puller");
    this.mint = opts.mint ?? fakeAddress("mint");
  }

  // ---------------------------------------------------------------- test controls

  now(): Date {
    return new Date(this.clock);
  }
  setNow(d: Date) {
    if (d.getTime() < this.clock) throw new Error("time only moves forward");
    this.clock = d.getTime();
  }
  advance(ms: number) {
    this.clock += ms;
  }

  createPlan(p: { owner: string; planId?: bigint; amount: bigint; periodHours: number; pullers?: string[]; endTs?: bigint }): OnchainPlan {
    const planId = p.planId ?? BigInt(this.plans.size + 1);
    const plan: OnchainPlan = {
      address: `plan_${p.owner}_${planId}`,
      owner: p.owner,
      planId,
      mint: this.mint,
      amount: p.amount,
      periodHours: p.periodHours,
      createdAt: BigInt(Math.floor(this.clock / 1000)),
      endTs: p.endTs ?? 0n,
      status: "active",
      pullers: p.pullers ?? [this.pullerAddress],
      destinations: [p.owner],
    };
    this.plans.set(plan.address, plan);
    this.balances.set(p.owner, this.balances.get(p.owner) ?? 0n);
    return plan;
  }

  /** A customer wallet with a token account holding `amount`. */
  wallet(amount: bigint, name = fakeAddress("wallet")): string {
    this.balances.set(name, amount);
    return name;
  }

  /** What a browser wallet does: sign the transaction it was given, unchanged. */
  walletSign(transaction: string, signer: string): string {
    const w = dec<Wire>(transaction);
    return enc({ ...w, signers: [...w.signers, signer] });
  }

  /** The subscriber signs cancelSubscription: it ends at the end of the current period. */
  cancel(subscriptionAddress: string) {
    const s = this.mustSub(subscriptionAddress);
    this.roll(s);
    s.expiresAt = new Date(s.currentPeriodStart.getTime() + s.periodHours * HOUR);
  }
  resume(subscriptionAddress: string) {
    this.mustSub(subscriptionAddress).expiresAt = null;
  }
  closeAuthority(owner: string) {
    this.authorities.delete(owner);
  }

  /** Land every send that was left pending. */
  landPending() {
    for (const { signature, op } of this.pendingOps.splice(0)) this.execute(signature, op);
  }

  /** Mark confirmed transactions finalized. */
  finalizeAll() {
    for (const t of this.txs.values()) if (t.state === "confirmed") t.state = "finalized";
  }

  // ---------------------------------------------------------------- Chain: reads

  private blockHeight(): bigint {
    return BigInt(Math.floor((this.clock - this.epoch) / SLOT_MS)) + 1000n;
  }

  async getPlan(address: string) {
    const p = this.plans.get(address);
    return p ? structuredClone(p) : null;
  }
  async getSubscription(address: string) {
    const s = this.subscriptions.get(address);
    return s ? structuredClone(s) : null;
  }
  async getAuthority(owner: string) {
    const a = this.authorities.get(owner);
    return a ? { ...a } : null;
  }
  async getTokenBalance(owner: string) {
    return this.balances.get(owner) ?? null;
  }
  async findPlanAddress(owner: string, planId: bigint) {
    return `plan_${owner}_${planId}`;
  }
  async findSubscriptionAddress(planAddress: string, subscriber: string) {
    return `sub_${planAddress}_${subscriber}`;
  }
  async getBlockHeight() {
    return this.blockHeight();
  }
  async getStatuses(signatures: string[]): Promise<TxStatus[]> {
    return signatures.map((sig) => {
      const t = this.txs.get(sig);
      if (!t) return { state: "unknown" };
      if (t.state === "failed") return { state: "failed", error: t.error! };
      return { state: t.state };
    });
  }

  // ---------------------------------------------------------------- Chain: writes

  async buildActivation(input: ActivationInput): Promise<BuiltActivation> {
    const authority = this.authorities.get(input.subscriber);
    const op: Op = {
      kind: "activation",
      plan: input.plan.address,
      subscriber: input.subscriber,
      initAuthority: !authority,
      expectedInitId: authority ? authority.initId : null,
      firstPull: input.firstPull.toString(),
      cancelPlan: input.cancel?.plan ?? null,
    };
    return { ...this.forWallet(op), createsAuthority: !authority };
  }

  private forWallet(op: Op): BuiltTx {
    const lastValidBlockHeight = this.blockHeight() + BLOCKHASH_LIFETIME;
    const message = enc({ op, lastValidBlockHeight: lastValidBlockHeight.toString(), nonce: randomBytes(4).toString("hex") });
    return { transaction: enc({ message, signers: [] } satisfies Wire), message, lastValidBlockHeight };
  }

  async buildCancel(input: { plan: string; subscriber: string }): Promise<BuiltTx> {
    return this.forWallet({ kind: "cancel", plan: input.plan, subscriber: input.subscriber });
  }

  async buildResume(input: { plan: string; subscriber: string; expiresAt: Date }): Promise<BuiltTx> {
    return this.forWallet({ kind: "resume", plan: input.plan, subscriber: input.subscriber, expiresAt: input.expiresAt.getTime() });
  }

  async buildTransfer(input: TransferInput): Promise<BuiltTx> {
    return this.forWallet({ kind: "transfer", from: input.from, to: input.to, amount: input.amount.toString(), reference: input.reference });
  }

  newReference(): string {
    return fakeAddress("ref");
  }

  async buildCreatePlan(input: { owner: string; planId: bigint; amount: bigint; periodHours: number; metadataUri: string }) {
    return {
      ...this.forWallet({ kind: "createPlan", owner: input.owner, planId: input.planId.toString(), amount: input.amount.toString(), periodHours: input.periodHours }),
      planAddress: `plan_${input.owner}_${input.planId}`,
    };
  }

  async cosign(signedTransaction: string, expectedMessage: string, subscriber: string, lastValidBlockHeight: bigint): Promise<PreparedTx> {
    let w: Wire;
    try {
      w = dec<Wire>(signedTransaction);
    } catch {
      throw new ActivationRejected("the signed transaction could not be decoded");
    }
    if (w.message !== expectedMessage) throw new ActivationRejected("the signed transaction is not the one we built");
    if (!w.signers.includes(subscriber)) throw new ActivationRejected("the transaction is not signed by the subscriber's wallet");
    return {
      signature: fakeAddress("sig"),
      wire: enc({ ...w, signers: [...w.signers, this.pullerAddress] }),
      lastValidBlockHeight,
    };
  }

  async preparePull(input: PullInput): Promise<PreparedTx> {
    const lastValidBlockHeight = this.blockHeight() + BLOCKHASH_LIFETIME;
    const op: Op = {
      kind: "pull",
      plan: input.plan.address,
      subscription: input.subscriptionAddress,
      subscriber: input.subscriber,
      amount: input.amount.toString(),
    };
    return {
      signature: fakeAddress("sig"),
      wire: enc({ message: enc({ op, lastValidBlockHeight: lastValidBlockHeight.toString() }), signers: [this.pullerAddress] } satisfies Wire),
      lastValidBlockHeight,
    };
  }

  async send(tx: PreparedTx): Promise<SendResult> {
    if (this.txs.has(tx.signature)) return { ok: true }; // a resend of the same bytes is a no-op on Solana
    const w = dec<Wire>(tx.wire);
    const { op, lastValidBlockHeight } = dec<{ op: Op; lastValidBlockHeight: string }>(w.message);
    if (this.blockHeight() > BigInt(lastValidBlockHeight)) {
      return { ok: false, definite: true, error: chainError("transient", "BlockhashNotFound") };
    }
    const mode = this.sendModes.shift() ?? "ok";
    switch (mode) {
      case "drop":
        return { ok: true };
      case "timeout_drops":
        return { ok: false, definite: false, error: chainError("transient", "fetch failed: timeout") };
      case "timeout_lands":
        this.execute(tx.signature, op);
        return { ok: false, definite: false, error: chainError("transient", "fetch failed: timeout") };
      case "pending":
        this.pendingOps.push({ signature: tx.signature, op });
        this.txs.set(tx.signature, { state: "pending", op });
        return { ok: true };
      case "ok": {
        // Preflight: a transaction that would fail is rejected and never forwarded.
        const err = this.simulate(op);
        if (err) return { ok: false, definite: true, error: err };
        this.execute(tx.signature, op);
        return { ok: true };
      }
    }
  }

  // ---------------------------------------------------------------- program rules

  private mustSub(address: string) {
    const s = this.subscriptions.get(address);
    if (!s) throw new Error(`no subscription ${address}`);
    return s;
  }

  /** Advance the record's period start by whole periods, as the program does on a pull. */
  private roll(s: OnchainSubscription) {
    const len = s.periodHours * HOUR;
    const elapsed = this.clock - s.currentPeriodStart.getTime();
    if (elapsed >= len) {
      const k = Math.floor(elapsed / len);
      s.currentPeriodStart = new Date(s.currentPeriodStart.getTime() + k * len);
      s.amountPulledInPeriod = 0n;
    }
  }

  private err(code: number, message: string): ChainError {
    return chainError(kindForCode(code), message, code);
  }

  /** Run the op against a copy of state and report the error, if any. */
  private simulate(op: Op): ChainError | null {
    const snapshot = {
      subs: new Map([...this.subscriptions].map(([k, v]) => [k, structuredClone(v)])),
      auth: new Map([...this.authorities].map(([k, v]) => [k, { ...v }])),
      bal: new Map(this.balances),
      nextInitId: this.nextInitId,
      transfers: this.transfers.length,
    };
    const err = this.apply(op, "simulation");
    this.subscriptions.clear();
    for (const [k, v] of snapshot.subs) this.subscriptions.set(k, v);
    this.authorities.clear();
    for (const [k, v] of snapshot.auth) this.authorities.set(k, v);
    this.balances.clear();
    for (const [k, v] of snapshot.bal) this.balances.set(k, v);
    this.nextInitId = snapshot.nextInitId;
    this.transfers.length = snapshot.transfers;
    return err;
  }

  private execute(signature: string, op: Op) {
    const err = this.apply(op, signature);
    this.txs.set(signature, err ? { state: "failed", error: err, op } : { state: "confirmed", op });
  }

  /** Apply all instructions of an op atomically. Returns the failing instruction's error. */
  private apply(op: Op, signature: string): ChainError | null {
    if (op.kind === "createPlan") {
      if (this.plans.has(`plan_${op.owner}_${op.planId}`)) return chainError("unknown", "plan already exists");
      if (signature !== "simulation") this.createPlan({ owner: op.owner, planId: BigInt(op.planId), amount: BigInt(op.amount), periodHours: op.periodHours });
      return null;
    }
    if (op.kind === "transfer") {
      const amount = BigInt(op.amount);
      if (!this.balances.has(op.from)) return chainError("not_found", "the payer has no token account");
      if (!this.balances.has(op.to)) return chainError("not_found", "the receiver has no token account");
      if (this.frozen.has(op.from)) return this.err(ERROR_CODES.TOKEN_ACCOUNT_FROZEN, "AccountFrozen");
      if (this.balances.get(op.from)! < amount) return this.err(ERROR_CODES.TOKEN_INSUFFICIENT_FUNDS, "insufficient funds");
      this.balances.set(op.from, this.balances.get(op.from)! - amount);
      this.balances.set(op.to, this.balances.get(op.to)! + amount);
      if (signature !== "simulation") this.transfers.push({ from: op.from, to: op.to, amount, signature, at: this.now() });
      return null;
    }

    const plan = this.plans.get(op.plan);
    if (!plan) return chainError("not_found", `plan ${op.plan} not found`);

    if (op.kind === "cancel" || op.kind === "resume") {
      const s = this.subscriptions.get(`sub_${plan.address}_${op.subscriber}`);
      if (!s) return chainError("not_found", "subscription not found");
      if (op.kind === "cancel") {
        if (s.expiresAt) return chainError("unknown", "SubscriptionAlreadyCancelled");
        this.cancel(s.address);
      } else {
        if (!s.expiresAt || s.expiresAt.getTime() !== op.expiresAt) return chainError("unknown", "StaleExpiry");
        if (this.clock >= s.expiresAt.getTime()) return this.err(ERROR_CODES.SUBSCRIPTION_CANCELLED, "SubscriptionCancelled");
        s.expiresAt = null;
      }
      return null;
    }

    if (op.kind === "activation") {
      // Work on copies so a failure part-way leaves nothing behind.
      let authority = this.authorities.get(op.subscriber);
      if (op.initAuthority) {
        if (authority) return chainError("unknown", "subscription authority already in use");
        if (!this.balances.has(op.subscriber)) return chainError("not_found", "subscriber has no token account");
        authority = { address: `auth_${op.subscriber}`, initId: this.nextInitId };
      } else if (!authority || op.expectedInitId === null || authority.initId !== BigInt(op.expectedInitId)) {
        return this.err(ERROR_CODES.STALE_SUBSCRIPTION_AUTHORITY, "StaleSubscriptionAuthority");
      }
      const subAddress = `sub_${plan.address}_${op.subscriber}`;
      if (this.subscriptions.has(subAddress)) return chainError("unknown", "AlreadySubscribed");
      const sub: OnchainSubscription = {
        address: subAddress,
        subscriber: op.subscriber,
        plan: plan.address,
        payer: this.pullerAddress,
        initId: authority.initId,
        amount: plan.amount,
        periodHours: plan.periodHours,
        amountPulledInPeriod: 0n,
        // The program stores whole seconds.
        currentPeriodStart: new Date(Math.floor(this.clock / 1000) * 1000),
        expiresAt: null,
      };
      const first = BigInt(op.firstPull);
      if (first > 0n) {
        const e = this.checkPull(plan, sub, first);
        if (e) return e;
      }
      const old = op.cancelPlan ? this.subscriptions.get(`sub_${op.cancelPlan}_${op.subscriber}`) : undefined;
      if (op.cancelPlan && (!old || old.expiresAt)) return chainError("unknown", "cannot cancel the old subscription");
      if (op.initAuthority) {
        this.authorities.set(op.subscriber, authority);
        this.nextInitId++;
      }
      this.subscriptions.set(subAddress, sub);
      if (first > 0n) this.transfer(plan, sub, first, signature);
      if (old) this.cancel(old.address);
      return null;
    }

    const sub = this.subscriptions.get(op.subscription);
    if (!sub) return chainError("not_found", `subscription ${op.subscription} not found`);
    const amount = BigInt(op.amount);
    const e = this.checkPull(plan, sub, amount);
    if (e) return e;
    this.transfer(plan, sub, amount, signature);
    return null;
  }

  private checkPull(plan: OnchainPlan, sub: OnchainSubscription, amount: bigint): ChainError | null {
    if (amount === 0n) return this.err(ERROR_CODES.INVALID_AMOUNT, "InvalidAmount");
    const auth = this.authorities.get(sub.subscriber);
    // In an activation the authority may be created in the same transaction.
    if (auth && auth.initId !== sub.initId) return this.err(ERROR_CODES.STALE_SUBSCRIPTION_AUTHORITY, "StaleSubscriptionAuthority");
    if (!auth && this.subscriptions.has(sub.address)) return this.err(ERROR_CODES.STALE_SUBSCRIPTION_AUTHORITY, "StaleSubscriptionAuthority");
    if (plan.endTs !== 0n && BigInt(Math.floor(this.clock / 1000)) > plan.endTs) return this.err(ERROR_CODES.PLAN_EXPIRED, "PlanExpired");
    if (sub.expiresAt && this.clock >= sub.expiresAt.getTime()) return this.err(ERROR_CODES.SUBSCRIPTION_CANCELLED, "SubscriptionCancelled");
    const probe = structuredClone(sub);
    this.roll(probe);
    if (probe.amountPulledInPeriod + amount > plan.amount) return this.err(ERROR_CODES.AMOUNT_EXCEEDS_PERIOD_LIMIT, "AmountExceedsPeriodLimit");
    if (this.frozen.has(sub.subscriber)) return this.err(ERROR_CODES.TOKEN_ACCOUNT_FROZEN, "AccountFrozen");
    if ((this.balances.get(sub.subscriber) ?? 0n) < amount) return this.err(ERROR_CODES.TOKEN_INSUFFICIENT_FUNDS, "insufficient funds");
    return null;
  }

  private transfer(plan: OnchainPlan, sub: OnchainSubscription, amount: bigint, signature: string) {
    this.roll(sub);
    sub.amountPulledInPeriod += amount;
    this.balances.set(sub.subscriber, this.balances.get(sub.subscriber)! - amount);
    this.balances.set(plan.owner, (this.balances.get(plan.owner) ?? 0n) + amount);
    if (signature !== "simulation") this.transfers.push({ from: sub.subscriber, to: plan.owner, amount, signature, at: this.now() });
  }
}
