/**
 * Turning RPC and program errors into the reasons doc 03 acts on.
 *
 * Custom error codes come from the Subscriptions program (100 and up) or from
 * the SPL Token program it calls for the transfer (small numbers).
 */

import type { ChainError, ChainErrorKind } from "./types.ts";

/** Subscriptions program and SPL Token custom error codes we act on. */
export const ERROR_CODES = {
  // SPL Token, from the transfer the program performs.
  TOKEN_INSUFFICIENT_FUNDS: 1,
  TOKEN_ACCOUNT_FROZEN: 17,
  // Subscriptions program.
  DELEGATION_EXPIRED: 128,
  INVALID_AMOUNT: 129,
  UNAUTHORIZED: 130,
  STALE_SUBSCRIPTION_AUTHORITY: 136,
  AMOUNT_EXCEEDS_PERIOD_LIMIT: 400,
  PLAN_SUNSET: 500,
  PLAN_EXPIRED: 501,
  UNAUTHORIZED_DESTINATION: 506,
  SUBSCRIPTION_CANCELLED: 508,
  PLAN_CLOSED: 516,
} as const;

export function kindForCode(code: number): ChainErrorKind {
  switch (code) {
    case ERROR_CODES.TOKEN_INSUFFICIENT_FUNDS:
      return "insufficient_funds";
    case ERROR_CODES.TOKEN_ACCOUNT_FROZEN:
      return "account_frozen";
    case ERROR_CODES.AMOUNT_EXCEEDS_PERIOD_LIMIT:
      return "ceiling_reached";
    case ERROR_CODES.SUBSCRIPTION_CANCELLED:
    case ERROR_CODES.DELEGATION_EXPIRED:
      return "subscription_cancelled";
    case ERROR_CODES.PLAN_EXPIRED:
    case ERROR_CODES.PLAN_CLOSED:
      return "plan_expired";
    case ERROR_CODES.STALE_SUBSCRIPTION_AUTHORITY:
      return "stale_authority";
    case ERROR_CODES.UNAUTHORIZED:
    case ERROR_CODES.UNAUTHORIZED_DESTINATION:
      return "unauthorized";
    default:
      return "unknown";
  }
}

export function chainError(kind: ChainErrorKind, message: string, code: number | null = null): ChainError {
  return { kind, code, message };
}

/** Find a custom program error code anywhere in an error chain or a status `err` object. */
export function customCode(err: unknown): number | undefined {
  const seen = new Set<unknown>();
  const walk = (e: unknown): number | undefined => {
    if (!e || typeof e !== "object" || seen.has(e)) return;
    seen.add(e);
    const o = e as Record<string, unknown>;
    const ctx = o.context as Record<string, unknown> | undefined;
    if (typeof ctx?.code === "number" && typeof ctx?.index === "number") return ctx.code;
    if (o.Custom !== undefined) return Number(o.Custom);
    for (const v of Object.values(o)) {
      const r = walk(v);
      if (r !== undefined) return r;
    }
    return walk(o.cause);
  };
  return walk(err);
}

const TRANSIENT = /InsufficientFundsForFee|InsufficientFundsForRent|BlockhashNotFound|Blockhash not found|AccountNotFound|AlreadyProcessed|WouldExceed|TooManyRequests|\(429\)/i;

/** Classify a transaction error: a SolanaError thrown by RPC, or the `err` field of a signature status. */
export function classify(err: unknown): ChainError {
  const code = customCode(err);
  const message = describe(err);
  if (code !== undefined) return chainError(kindForCode(code), message, code);
  // Fee payer problems are ours to fix, not the customer's.
  if (TRANSIENT.test(message)) return chainError("transient", message);
  return chainError("unknown", message);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause ? `${err.message} (${describe(cause)})` : err.message;
  }
  try {
    return JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(err);
  }
}
