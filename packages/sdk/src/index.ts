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
    // Not always JSON: a proxy in front of the API can answer 502 or 429 with an HTML page.
    let json: { error?: { code?: string; message?: string } } | null = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (res.ok) throw new NummoUnavailableError(`nummo API returned a body that is not JSON (status ${res.status})`);
    }
    // 501 (not built yet) and settlement_unavailable (not configured) are definite answers, not outages,
    // so they must not fail open.
    const definite = res.status === 501 || json?.error?.code === "settlement_unavailable";
    // A 429 is temporary too: check fails open and track is queued and resent with its idempotency key.
    if (res.status === 429) throw new NummoUnavailableError(`nummo API rate limit: ${json?.error?.message ?? text}`);
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
   * `checkoutUrl` where the customer connects a wallet and signs once. Moving
   * from a paid plan: an upgrade returns a checkout for the prorated difference;
   * a downgrade returns `status: "scheduled"` and takes effect at the period end.
   * Attaching the current plan again cancels a scheduled downgrade.
   */
  attach(p: { customerId: string; planId: string; version?: number; successUrl?: string; skipPayment?: boolean }) {
    return this.request<AttachResponse>("POST", "/v1/attach", p);
  }

  /** What attaching a plan would do and cost now, without changing anything. */
  preview(p: { customerId: string; planId: string; version?: number }) {
    return this.request<PreviewResponse>("POST", "/v1/preview", p);
  }

  /**
   * A one-off purchase of a feature's balance (configured under `topUps`).
   * `amount` is in token base units: `usdc("10")` from @usenummo/config.
   * Returns a checkout URL where the customer pays with one signature.
   */
  topUp(p: { customerId: string; featureId: string; amount: bigint | string; successUrl?: string }) {
    return this.request<{ checkoutUrl: string; featureId: string; quantity: string; amount: string }>("POST", "/v1/topups", {
      ...p,
      amount: p.amount.toString(),
    });
  }

  /**
   * A link to the hosted customer portal: plan, ceiling, usage, receipts, plan
   * changes, top-ups, and cancel signed by the customer's wallet. Valid for an hour;
   * create one each time the customer opens billing.
   */
  portal(p: { customerId: string; returnUrl?: string }) {
    return this.request<{ url: string; expiresAt: string }>("POST", "/v1/portal", p);
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
    list: (p: { search?: string; limit?: number; offset?: number } = {}) => {
      const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      return this.request<{ total: number; customers: CustomerSummary[] }>("GET", `/v1/customers${qs.size ? `?${qs}` : ""}`);
    },
    get: (id: string) => this.request<Customer>("GET", `/v1/customers/${encodeURIComponent(id)}`),
    invoices: (id: string) => this.request<{ invoices: Invoice[] }>("GET", `/v1/customers/${encodeURIComponent(id)}/invoices`),
    upsert: (id: string, p: { name?: string | null; email?: string | null } = {}) =>
      this.request<Customer>("PUT", `/v1/customers/${encodeURIComponent(id)}`, p),
  };

  /**
   * Gate a route for agents and other callers without a plan (milestone M4).
   * A signed-in customer with the balance is served from it; anyone else gets
   * a `402 Payment Required` offering x402 and MPP, and is served once they
   * pay. Paid requests are recorded in nummo against the customer, or against
   * the paying wallet (`wallet:<address>`). The price comes from `payPerUse`
   * in the pricing config.
   *
   *   const gate = nummo.paywall({ featureId: "premium_message", identify: (req) => userIdFrom(req) });
   *   app.post("/agent/chat", gate.hono(), handler);              // Hono
   *   const r = await gate.check(request);                        // anything with web Requests
   *   if (!r.ok) return r.response;                               // the 402 (or 503)
   *   return withHeaders(await handler(request), r.headers);      // receipts go back to the payer
   *
   * Only payment headers are sent to nummo: `payment-signature`, `x-payment`,
   * `accept`, and `authorization` when it carries an MPP credential
   * (`Payment ...`), never your app's own bearer tokens.
   *
   * If the API cannot be reached, a signed-in customer is served (fail open,
   * unless the feature is in `failClosed`) and anyone else gets a 503.
   */
  paywall(opts: PaywallOptions) {
    const run = async (request: Request): Promise<PaywallResult> => {
      const customerId = (await opts.identify?.(request)) ?? undefined;
      const value = typeof opts.value === "function" ? await opts.value(request) : (opts.value ?? 1);
      const properties = typeof opts.properties === "function" ? await opts.properties(request) : opts.properties;
      const headers: Record<string, string> = {};
      for (const name of ["payment-signature", "x-payment", "accept"]) {
        const v = request.headers.get(name);
        if (v) headers[name] = v;
      }
      const auth = request.headers.get("authorization");
      if (auth && /^payment\s/i.test(auth)) headers.authorization = auth;
      try {
        const r = await this.pay({
          request: { method: request.method, url: request.url, headers },
          featureId: opts.featureId,
          value,
          customerId,
          properties,
          description: opts.description,
        });
        if (r.status === "payment_required") {
          return { ok: false, response: new Response(r.response.body, { status: r.response.status, headers: r.response.headers }), price: r.price };
        }
        return { ok: true, customerId: r.customerId, paid: r.status === "paid", headers: r.headers, event: r.event };
      } catch (e) {
        if (!(e instanceof NummoUnavailableError)) throw e;
        if (customerId && !this.failClosed.has(opts.featureId)) {
          return { ok: true, customerId, paid: false, headers: {}, event: null, failedOpen: true };
        }
        const body = JSON.stringify({ error: { code: "unavailable", message: "billing is unavailable; try again shortly" } });
        return { ok: false, response: new Response(body, { status: 503, headers: { "content-type": "application/json", "retry-after": "5" } }), price: null };
      }
    };
    return {
      check: run,
      /** Hono middleware: answers the 402 itself, or runs the route and adds the payment receipt headers. */
      hono:
        () =>
        async (c: { req: { raw: Request }; res: Response; set: (key: "nummo", value: PaywallGranted) => void }, next: () => Promise<void>) => {
          const r = await run(c.req.raw);
          if (!r.ok) return r.response;
          c.set("nummo", r);
          await next();
          for (const [k, v] of Object.entries(r.headers)) c.res.headers.set(k, v);
        },
      /** Wrap a fetch-style handler (Next.js route handlers, Workers, Bun, Deno). */
      fetch: (handler: (request: Request, grant: PaywallGranted) => Response | Promise<Response>) => async (request: Request) => {
        const r = await run(request);
        if (!r.ok) return r.response;
        const res = await handler(request, r);
        const out = new Response(res.body, res);
        for (const [k, v] of Object.entries(r.headers)) out.headers.set(k, v);
        return out;
      },
    };
  }

  /** The call behind `paywall`: forward a request's payment headers to nummo. */
  pay(p: {
    request: { method: string; url: string; headers: Record<string, string> };
    featureId: string;
    value?: Quantity;
    customerId?: string;
    idempotencyKey?: string;
    properties?: Record<string, unknown>;
    description?: string;
  }) {
    return this.request<PayResponse>("POST", "/v1/pay", { ...p, value: q(p.value) });
  }

  /**
   * Record a model call's tokens at the model's price (`models` in the pricing
   * config). Each kind of token is a usage event on the model's feature for it.
   */
  trackTokens(p: { customerId: string; model: string; usage: TokenUsage; idempotencyKey?: string; properties?: Record<string, unknown> }) {
    return this.request<{ customerId: string; model: string; events: (TrackResponse & { kind: keyof TokenUsage })[] }>("POST", "/v1/track/tokens", {
      ...p,
      usage: tokenUsage(p.usage),
    });
  }

  /** May this customer make this model call? Pass the expected tokens, for example the prompt size and max output. */
  checkTokens(p: { customerId: string; model: string; usage: TokenUsage }) {
    return this.request<CheckResponse & { model: string }>("POST", "/v1/check/tokens", { ...p, usage: tokenUsage(p.usage) });
  }

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


export type TokenUsage = { input?: Quantity; output?: Quantity; cachedInput?: Quantity };

function tokenUsage(u: TokenUsage) {
  return { input: q(u.input), output: q(u.output), cachedInput: q(u.cachedInput) };
}

export type PaidEvent = TrackResponse & {
  paid: { protocol: "x402" | "mpp"; signature: string; amount: string; wallet: string | null; invoiceId: string };
};

export type PayResponse =
  | { status: "allowed"; customerId: string; event: TrackResponse | null; headers: Record<string, string> }
  | {
      status: "payment_required";
      response: { status: number; headers: Record<string, string>; body: string };
      price: { featureId: string; value: string; amount: string; payTo: string } | null;
    }
  /** `event` is null only if the payment settled but nummo could not record it (the API logs it). */
  | { status: "paid"; customerId: string; event: PaidEvent | null; headers: Record<string, string> };

export type PaywallOptions = {
  /** The metered feature the route uses. Agents pay its `payPerUse` price. */
  featureId: string;
  /** Units the request uses. Default 1. */
  value?: Quantity | ((request: Request) => Quantity | Promise<Quantity>);
  /** The signed-in customer, if any. Return undefined for agents and other anonymous callers. */
  identify?: (request: Request) => string | null | undefined | Promise<string | null | undefined>;
  /** Shown to the payer in the challenge. */
  description?: string;
  properties?: Record<string, unknown> | ((request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>);
};

export type PaywallGranted = {
  ok: true;
  customerId: string;
  /** True when the request was paid on the spot rather than from a balance. */
  paid: boolean;
  /** Payment receipt headers (`payment-response`, `payment-receipt`): add them to your response. */
  headers: Record<string, string>;
  event: TrackResponse | PaidEvent | null;
  failedOpen?: boolean;
};

export type PaywallResult = PaywallGranted | { ok: false; response: Response; price: { featureId: string; value: string; amount: string; payTo: string } | null };

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
    price: { amount: string; periodHours: number; period: string } | null;
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
    /** Set when an immediate plan change replaced it; it grants nothing and ends with its on-chain period. */
    replacedBy: string | null;
    /** A downgrade waiting for the period end. */
    scheduledChange: { planId: string; version: number; name: string; effectiveAt: string } | null;
    createdAt: string;
    endedAt: string | null;
  }[];
  /** Checkouts waiting for the customer to sign. */
  pendingCheckouts: { id: string; kind: "subscribe" | "change" | "topup"; status: string; planId: string | null; version: number | null; featureId: string | null; amount: string; expiresAt: string }[];
  balances: {
    featureId: string;
    balance: string;
    granted: string;
    breakdown: { grantId: string; source: string; amount: string; remaining: string; expiresAt: string | null }[];
  }[];
  invoices: Invoice[];
};

export type AttachResponse = {
  subscriptionId: string | null;
  status: "active" | "pending" | "scheduled" | "past_due" | "canceling";
  checkoutUrl: string | null;
  alreadyAttached: boolean;
  /** An upgrade from a paid plan: credit for the unused part of the period, and what is due now. */
  proration?: { credit: string; dueNow: string };
  /** A downgrade: when it takes effect. */
  effectiveAt?: string;
  replaced?: string[];
};

export type PreviewResponse = {
  change: "new" | "upgrade" | "downgrade" | "none" | "blocked";
  plan: { planId: string; version: number; name: string; price: { amount: string; periodHours: number; period: string } | null; ceiling: string | null };
  from: { planId: string; version: number; subscriptionId: string } | null;
  dueNow: string;
  credit: string;
  effectiveAt: string | null;
  signatureRequired: boolean;
  reason?: string;
};

export type CustomerSummary = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string;
  plans: { planId: string; version: number; name: string; status: string; paid: boolean }[];
};

export type Invoice = {
  id: string;
  subscriptionId: string | null;
  kind: "activation" | "renewal" | "overage" | "topup" | "pay_per_use";
  status: "open" | "paid" | "void" | "uncollectible";
  periodStart: string;
  total: string;
  amountPaid: string;
  createdAt: string;
  paidAt: string | null;
  lines: { kind: "base" | "overage" | "writeoff" | "proration" | "topup" | "pay_per_use"; featureId: string | null; quantity: string | null; amount: string }[];
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
