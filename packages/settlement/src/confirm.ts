/**
 * Deciding what happened to a transaction we signed (doc 03, "Sending
 * transactions safely"): it confirmed, it failed, it can no longer land
 * because its blockhash expired, or we do not know yet.
 */

import type { Chain, ChainError } from "@usenummo/solana";

export type Outcome =
  | { state: "confirmed"; finalized: boolean }
  | { state: "failed"; error: ChainError }
  /** The blockhash expired and the cluster never saw it: safe to send a new transaction. */
  | { state: "expired" }
  | { state: "pending" };

export async function outcomeOf(chain: Chain, signature: string, lastValidBlockHeight: bigint): Promise<Outcome> {
  const [st] = await chain.getStatuses([signature]);
  switch (st?.state) {
    case "confirmed":
      return { state: "confirmed", finalized: false };
    case "finalized":
      return { state: "confirmed", finalized: true };
    case "failed":
      return { state: "failed", error: st.error };
    case "pending":
      return { state: "pending" };
    default: {
      // Not found. Only once the blockhash has expired is it certain never to land.
      const height = await chain.getBlockHeight();
      if (height <= lastValidBlockHeight) return { state: "pending" };
      // Check once more: it may have landed between the two calls.
      const [again] = await chain.getStatuses([signature]);
      if (again?.state === "confirmed" || again?.state === "finalized") return { state: "confirmed", finalized: again.state === "finalized" };
      if (again?.state === "failed") return { state: "failed", error: again.error };
      return { state: "expired" };
    }
  }
}

/** Poll until the outcome is known or `waitMs` passes. */
export async function waitForOutcome(chain: Chain, signature: string, lastValidBlockHeight: bigint, waitMs: number, pollMs: number): Promise<Outcome> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const o = await outcomeOf(chain, signature, lastValidBlockHeight);
    if (o.state !== "pending" || Date.now() >= deadline) return o;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Customer-facing words for why a transaction failed. */
export function describeFailure(e: ChainError): string {
  switch (e.kind) {
    case "insufficient_funds":
      return "The wallet does not hold enough USDC for this payment.";
    case "account_frozen":
      return "The wallet's USDC account is frozen.";
    case "subscription_cancelled":
      return "The subscription was cancelled on-chain.";
    case "plan_expired":
      return "The on-chain plan has ended.";
    case "stale_authority":
      return "The wallet's subscription authority changed. Reconnect and sign again.";
    case "ceiling_reached":
      return "The period's on-chain ceiling has been reached.";
    case "transient":
      return "The network did not accept the transaction. Try again.";
    default:
      return `The transaction failed: ${e.message}`;
  }
}
