/**
 * TypeScript client for the nummo API (doc 04).
 *
 *   const nummo = new Nummo({ secretKey: process.env.NUMMO_SECRET_KEY });
 *   const { allowed } = await nummo.check({ customerId, featureId: "premium_message" });
 *   await nummo.track({ customerId, featureId: "premium_message", value: 1 });
 *
 * Failure mode (doc 02): the client fails open by default. If the API cannot be
 * reached, `check` returns `allowed: true` with `failedOpen: true`, and `track`
 * is queued and resent in the background. Every tracked event carries an
 * idempotency key, so a resend can never be counted twice. Features listed in
 * `failClosed` are refused instead when the API is unreachable.
 */

export type Quantity = number | string;

export type NummoOptions = {
  secretKey?: string;
  baseUrl?: string;
  /** Per-request timeout. Default 5 seconds. */
  timeoutMs?: number;
  /** Feature ids that must be refused, not allowed, when the API is unreachable. */
  failClosed?: string[];
  /** Max queued track calls kept in memory while the API is unreachable. Default 10,000. */
  maxQueue?: number;
  fetch?: typeof fetch;
};

export type CheckParams = {
  customerId: string;
  featureId: string;
  requiredBalance?: Quantity;
  sendEvent?: boolean;
  idempotencyKey?: string;
  properties?: Record<string, unknown>;
  lock?: { lockId: string; expiresAt: number | Date };
};

export type CheckResponse = {
  allowed: boolean;
  customerId: string;
  featureId: string;
  type?: "boolean" | "metered" | "credit_system";
  requiredBalance?: string | null;
  available?: string | null;
  balances?: { featureId: string; balance: string; rate: string }[];
  overage?: { allowed: boolean; headroom: string } | null;
  nextResetAt?: string | null;
  lock?: { lockId: string; expiresAt: string };
  event?: TrackResponse;
  /** True when the API was unreachable and the answer came from the fail-open policy. */
  failedOpen?: boolean;
};

export type TrackParams = {
  customerId: string;
  featureId: string;
  value?: Quantity;
  idempotencyKey?: string;
  properties?: Record<string, unknown>;
  occurredAt?: Date;
};

export type TrackResponse = {
  id: string;
  customerId: string;
  featureId: string;
  value: string;
  deducted: { featureId: string; amount: string }[];
  overage: { featureId: string; units: string; amount: string } | null;
  unabsorbed: string;
  replayed: boolean;
};

export class NummoApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "NummoApiError";
    this.code = code;
    this.status = status;
  }
}

/** The API could not be reached, timed out, or failed with a 5xx. */
export class NummoUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NummoUnavailableError";
  }
}

const q = (v: Quantity | undefined) => (v === undefined ? undefined : typeof v === "number" ? numberToDecimal(v) : v);

function numberToDecimal(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`invalid quantity ${n}`);
  return n.toFixed(9).replace(/\.?0+$/, "") || "0";
}

/** 1 USDC = 1_000_000 base units. usdc("0.01") === 10_000n */
export function usdc(amount: string | number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  if (!/^\d+$/.test(whole!) || !/^\d{0,6}$/.test(frac)) throw new RangeError(`invalid USDC amount ${amount}`);
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

export class Nummo {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly failClosed: Set<string>;
  private readonly maxQueue: number;
  private readonly fetchImpl: typeof fetch;
  private readonly queue: { params: TrackParams & { idempotencyKey: string }; attempts: number }[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: NummoOptions = {}) {
    const key = opts.secretKey ?? process.env.NUMMO_SECRET_KEY;
    if (!key) throw new Error("nummo: pass secretKey or set NUMMO_SECRET_KEY");
    this.key = key;
    this.baseUrl = (opts.baseUrl ?? process.env.NUMMO_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.failClosed = new Set(opts.failClosed ?? []);
    this.maxQueue = opts.maxQueue ?? 10_000;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Number of track calls waiting to be resent. */
  get pending(): number {
    return this.queue.length;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new NummoUnavailableError(`nummo API unreachable: ${(e as Error).message}`, { cause: e });
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    // 501 (not built yet) and settlement_unavailable (not configured) are definite answers, not outages,
    // so they must not fail open.
    const definite = res.status === 501 || json?.error?.code === "settlement_unavailable";
    if (res.status >= 500 && !definite) throw new NummoUnavailableError(`nummo API error ${res.status}: ${json?.error?.message ?? text}`);
    if (!res.ok) throw new NummoApiError(res.status, json?.error?.code ?? "unknown", json?.error?.message ?? text);
    return json as T;
  }

  /** May this customer do this? Fails open unless the feature is in `failClosed`. */
  async check(p: CheckParams): Promise<CheckResponse> {
    const idempotencyKey = p.sendEvent ? (p.idempotencyKey ?? crypto.randomUUID()) : p.idempotencyKey;
    try {
      return await this.request<CheckResponse>("POST", "/v1/check", {
        ...p,
        idempotencyKey,
        requiredBalance: q(p.requiredBalance),
        lock: p.lock ? { lockId: p.lock.lockId, expiresAt: new Date(p.lock.expiresAt).toISOString() } : undefined,
      });
    } catch (e) {
      if (!(e instanceof NummoUnavailableError)) throw e;
      const allowed = !this.failClosed.has(p.featureId);
      // A fail-open check with sendEvent still owes the usage: queue it.
      if (allowed && p.sendEvent) {
        this.enqueue({ customerId: p.customerId, featureId: p.featureId, value: p.requiredBalance ?? 1, idempotencyKey: idempotencyKey!, properties: p.properties });
      }
      return { allowed, customerId: p.customerId, featureId: p.featureId, failedOpen: true };
    }
  }

  /**
   * Record usage. Returns null if the API was unreachable and the event was
   * queued for resend.
   */
  async track(p: TrackParams): Promise<TrackResponse | null> {
    const params = { ...p, idempotencyKey: p.idempotencyKey ?? crypto.randomUUID() };
    try {
      return await this.sendTrack(params);
    } catch (e) {
      if (!(e instanceof NummoUnavailableError)) throw e;
      this.enqueue(params);
      return null;
    }
  }

  private sendTrack(p: TrackParams & { idempotencyKey: string }) {
    return this.request<TrackResponse>("POST", "/v1/track", {
      ...p,
      value: q(p.value ?? 1),
      occurredAt: (p.occurredAt ?? new Date()).toISOString(),
    });
  }

  private enqueue(params: TrackParams & { idempotencyKey: string }) {
    if (this.queue.length >= this.maxQueue) this.queue.shift();
    this.queue.push({ params: { ...params, occurredAt: params.occurredAt ?? new Date() }, attempts: 0 });
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.queue.length === 0) return;
    const attempts = this.queue[0]?.attempts ?? 0;
    const delay = Math.min(1_000 * 2 ** attempts, 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  /** Resend queued track calls now. Resolves when the queue is empty or the API is still down. */
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      try {
        while (this.queue.length) {
          const item = this.queue[0]!;
          try {
            await this.sendTrack(item.params);
            this.queue.shift();
          } catch (e) {
            if (e instanceof NummoUnavailableError) {
              item.attempts++;
              return;
            }
            this.queue.shift(); // a 4xx will not succeed on retry
          }
        }
      } finally {
        this.flushing = null;
        this.schedule();
      }
    })();
    return this.flushing;
  }

  /**
   * Put a customer on a plan. Free plans attach at once. A paid plan returns a
   * `checkoutUrl` where the customer connects a wallet and signs once.
   */
  attach(p: { customerId: string; planId: string; version?: number; successUrl?: string; skipPayment?: boolean }) {
    return this.request<{ subscriptionId: string; status: string; checkoutUrl: string | null; alreadyAttached?: boolean }>("POST", "/v1/attach", p);
  }

  /** Compare nummo's records with the chain (doc 04, `nummo verify`). */
  verify() {
    return this.request<VerifyReport>("GET", "/v1/verify");
  }

  readonly plans = {
    list: () => this.request<PlanList>("GET", "/v1/plans"),
    /** Register the on-chain plan created for a plan version; the server checks its terms on-chain first. */
    publish: (planId: string, version: number, address: string) =>
      this.request<{ planId: string; version: number; address: string; owner: string; mint: string }>(
        "POST",
        `/v1/plans/${encodeURIComponent(planId)}/versions/${version}/publish`,
        { address },
      ),
  };

  readonly webhooks = {
    get: () => this.request<{ endpoint: WebhookEndpoint | null }>("GET", "/v1/webhook"),
    /** Set the endpoint events are POSTed to. Returns the signing secret. Replaces any previous endpoint. */
    set: (url: string) => this.request<{ endpoint: WebhookEndpoint }>("PUT", "/v1/webhook", { url }),
    remove: () => this.request<{ endpoint: null }>("DELETE", "/v1/webhook"),
  };

  readonly balances = {
    finalize: (p: { lockId: string; action: "confirm" | "release"; overrideValue?: Quantity; properties?: Record<string, unknown> }) =>
      this.request<{ lockId: string; status: string; event: TrackResponse | null }>("POST", "/v1/balances/finalize", {
        ...p,
        overrideValue: q(p.overrideValue),
      }),
    grant: (p: { customerId: string; featureId: string; amount: Quantity; expiresAt?: Date | null; source?: "manual" | "reward" | "topup" }) =>
      this.request<{ grantId: string }>("POST", "/v1/balances", { ...p, amount: q(p.amount), expiresAt: p.expiresAt?.toISOString() ?? null }),
  };

  readonly customers = {
    get: (id: string) => this.request<Customer>("GET", `/v1/customers/${encodeURIComponent(id)}`),
    invoices: (id: string) => this.request<{ invoices: Invoice[] }>("GET", `/v1/customers/${encodeURIComponent(id)}/invoices`),
    upsert: (id: string, p: { name?: string | null; email?: string | null } = {}) =>
      this.request<Customer>("PUT", `/v1/customers/${encodeURIComponent(id)}`, p),
  };

  readonly config = {
    /** Apply a config document (from @usenummo/config's toDocument). */
    push: (doc: unknown, opts: { dryRun?: boolean } = {}) =>
      this.request<{ changes: { kind: string; id: string; action: string }[]; dryRun: boolean }>(
        "PUT",
        `/v1/config${opts.dryRun ? "?dryRun=1" : ""}`,
        doc,
      ),
  };
}

export type Customer = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string;
  subscriptions: {
    id: string;
    planId: string;
    planName: string;
    version: number;
    status: string;
    price: { amount: string; periodHours: number } | null;
    ceiling: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    cancelAt: string | null;
    wallet: string | null;
    subscriptionAddress: string | null;
    pastDueSince: string | null;
    nextRetryAt: string | null;
    endedReason: string | null;
  }[];
  balances: {
    featureId: string;
    balance: string;
    granted: string;
    breakdown: { grantId: string; source: string; amount: string; remaining: string; expiresAt: string | null }[];
  }[];
  invoices: Invoice[];
};

export type Invoice = {
  id: string;
  subscriptionId: string;
  kind: "activation" | "renewal" | "overage";
  status: "open" | "paid" | "void" | "uncollectible";
  periodStart: string;
  total: string;
  amountPaid: string;
  createdAt: string;
  paidAt: string | null;
  lines: { kind: "base" | "overage" | "writeoff"; featureId: string | null; quantity: string | null; amount: string }[];
  payments: { signature: string; amount: string; status: string; createdAt: string }[];
};

export type VerifyReport = {
  env: "test" | "live";
  network: string;
  checkedAt: string;
  plans: number;
  subscriptions: number;
  ok: boolean;
  differences: { severity: "drift" | "notice"; kind: string; subject: string; message: string }[];
};

export type PlanList = {
  settlement: { network: string; mint: string; puller: string } | null;
  versions: {
    planId: string;
    version: number;
    name: string;
    status: string;
    paid: boolean;
    base: string;
    onchainTerms: { amount: string; periodHours: number; ceiling: string; period: string; planId: string; metadataUri: string } | null;
    published: { address: string; owner: string | null; publishedAt: string | null } | null;
  }[];
};

export type WebhookEndpoint = { id: string; url: string; secret: string; createdAt?: string };

/**
 * Check a webhook's X-Nummo-Signature header ("t=<unix>,v1=<hex>") against the
 * raw request body. Rejects signatures older than `toleranceSec`.
 */
export async function verifyWebhook(rawBody: string, header: string | null, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
