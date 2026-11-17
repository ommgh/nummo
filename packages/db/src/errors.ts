export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "customer_not_found"
  | "feature_not_found"
  | "plan_not_found"
  | "lock_not_found"
  | "lock_exists"
  | "lock_expired"
  | "lock_finalized"
  | "version_required"
  | "plan_not_published"
  | "checkout_not_found"
  | "checkout_closed"
  | "wallet_not_ready"
  | "activation_rejected"
  | "plan_change_blocked"
  | "topup_not_available"
  | "portal_not_found"
  | "wrong_wallet"
  | "settlement_unavailable"
  | "not_found"
  | "invalid_config"
  | "rate_limited"
  | "not_implemented"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  customer_not_found: 404,
  feature_not_found: 404,
  plan_not_found: 404,
  lock_not_found: 404,
  lock_exists: 409,
  lock_expired: 409,
  lock_finalized: 409,
  version_required: 409,
  plan_not_published: 409,
  checkout_not_found: 404,
  checkout_closed: 409,
  wallet_not_ready: 400,
  activation_rejected: 400,
  plan_change_blocked: 409,
  topup_not_available: 400,
  portal_not_found: 404,
  wrong_wallet: 400,
  settlement_unavailable: 503,
  not_found: 404,
  invalid_config: 400,
  rate_limited: 429,
  not_implemented: 501,
  internal: 500,
};

/** An error with a stable code, rendered as { "error": { "code", "message" } } (doc 04). */
export class NummoError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "NummoError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}
