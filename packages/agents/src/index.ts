/**
 * Agent payments (milestone M4, doc 03 "Agent payments: x402 and MPP").
 *
 * The merchant's app forwards a request's method, URL and payment headers to
 * `POST /v1/pay`. Here we decide, in this order:
 *
 *   1. The merchant identified the caller as a customer who has the balance:
 *      track the usage and serve. No 402.
 *   2. The request carries no valid payment: answer with the 402 challenge,
 *      offering both x402 (`exact`) and MPP (`charge`).
 *   3. The request carries a payment: verify and settle it, then record it as
 *      an invoice, a payment and a usage event against the customer, or against
 *      the paying wallet when the caller was not identified.
 *
 * Verification and settlement are Solana's own `@solana/pay-kit`, running in
 * process: the puller wallet pays the network fee as the operator, so the agent
 * needs only USDC. We do not run a facilitator for anyone else.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPayKit, Signer, Store, usd, type PayKit } from "@solana/pay-kit";
import { formatBaseUnits } from "@usenummo/core";
import {
  type Db,
  type Env,
  type PaidUsageResult,
  type Scope,
  type TrackResult,
  check,
  NummoError,
  quotePayPerUse,
  recordPaidUsage,
} from "@usenummo/db";
import { pgStore } from "./store.ts";

export { pgStore } from "./store.ts";

/** The part of pay-kit this module uses, so tests can stand in for the chain. */
export type PaymentGate = Pick<PayKit, "requirePayment">;

export type ForwardedRequest = {
  method: string;
  url: string;
  /** The request's headers. Only payment headers matter: `authorization`, `payment-signature`, `x-payment`, `accept`. */
  headers: Record<string, string>;
};

export type PayInput = {
  request: ForwardedRequest;
  featureId: string;
  /** Units of the feature this request uses. Default 1. */
  value?: string;
  /** The merchant's customer, when the caller is signed in. Optional for agents. */
  customerId?: string;
  idempotencyKey?: string;
  properties?: Record<string, unknown>;
  /** Shown to the payer in the challenge. */
  description?: string;
};

export type PayOutcome =
  | { status: "allowed"; customerId: string; event: TrackResult | null; headers: Record<string, string> }
  | {
      status: "payment_required";
      /** The response to send as it is: status (402), headers and body. */
      response: { status: number; headers: Record<string, string>; body: string };
      price: { featureId: string; value: string; amount: string; payTo: string } | null;
    }
  /** `event` is null only if the payment settled but could not be recorded (logged as an error). */
  | { status: "paid"; customerId: string; event: PaidUsageResult | null; headers: Record<string, string> };

const PAYMENT_HEADERS = ["authorization", "payment-signature", "x-payment", "accept", "content-type"];

/** Whether the request carries an x402 or MPP payment credential. */
export function hasPaymentCredential(headers: Record<string, string>): boolean {
  const h = lower(headers);
  return !!h["payment-signature"] || !!h["x-payment"] || /^payment\s/i.test(h.authorization ?? "");
}

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

async function responseOf(res: Response) {
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
}

export class AgentPayments {
  private readonly db: Db;
  private readonly gates: Partial<Record<Env, PaymentGate>>;
  private readonly rpcUrls: Partial<Record<Env, string>>;

  /** `rpcUrls` lets the payer of an MPP payment be read from its transaction (pay-kit does not report it). */
  constructor(db: Db, gates: Partial<Record<Env, PaymentGate>>, rpcUrls: Partial<Record<Env, string>> = {}) {
    this.db = db;
    this.gates = gates;
    this.rpcUrls = rpcUrls;
  }

  /** Whether agent payments are configured for an environment. */
  enabled(env: Env): boolean {
    return !!this.gates[env];
  }

  async pay(scope: Scope, input: PayInput): Promise<PayOutcome> {
    const value = input.value ?? "1";
    const credential = hasPaymentCredential(input.request.headers);

    // 1. A known customer with the balance is served from it.
    if (input.customerId && !credential) {
      const r = await check(this.db, scope, {
        customerId: input.customerId,
        featureId: input.featureId,
        requiredBalance: value,
        sendEvent: true,
        idempotencyKey: input.idempotencyKey,
        properties: input.properties,
      });
      if (r.allowed) return { status: "allowed", customerId: input.customerId, event: r.event ?? null, headers: {} };
    }

    let quote;
    try {
      quote = await quotePayPerUse(this.db, scope, input.featureId, value);
    } catch (e) {
      // An identified customer without the balance, on a feature agents cannot buy: a plain refusal.
      if (input.customerId && e instanceof NummoError && e.code === "pay_per_use_not_available") {
        return {
          status: "payment_required",
          price: null,
          response: {
            status: 402,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: { code: "insufficient_balance", message: `not enough ${input.featureId} left` } }),
          },
        };
      }
      throw e;
    }

    const gate = this.gates[scope.env];
    if (!gate) {
      throw new NummoError(
        "settlement_unavailable",
        `agent payments are not configured for the ${scope.env} environment (set NUMMO_${scope.env.toUpperCase()}_PULLER_KEY)`,
      );
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(input.request.headers)) if (PAYMENT_HEADERS.includes(k.toLowerCase())) headers.set(k, v);
    const request = new Request(input.request.url, { method: input.request.method, headers });
    const price = { featureId: quote.featureId, value: quote.value, amount: formatBaseUnits(quote.amount), payTo: quote.payTo };
    const r = await gate.requirePayment(request, () => ({
      amount: usd(price.amount),
      payTo: quote.payTo,
      description: input.description ?? `${quote.value} ${quote.featureId}`,
    }));

    if ("respond" in r) return { status: "payment_required", price, response: await responseOf(r.respond) };
    if (r.status === 402) return { status: "payment_required", price, response: await responseOf(r.response) };

    const payment = r.payment;
    const settlementHeaders = { ...payment.settlementHeaders, ...(await r.settle()) };
    const rpcUrl = this.rpcUrls[scope.env];
    const wallet = payment.payer || (rpcUrl ? await transferAuthority(rpcUrl, payment.transaction).catch(() => undefined) : undefined);
    let event: PaidUsageResult;
    try {
      event = await recordPaidUsage(this.db, scope, {
        customerId: input.customerId,
        wallet,
        featureId: quote.featureId,
        value: quote.value,
        amount: quote.amount,
        signature: payment.transaction,
        protocol: payment.protocol,
        idempotencyKey: input.idempotencyKey,
        properties: input.properties,
      });
    } catch (e) {
      // The money moved, so the caller is served; make sure an operator can find the payment.
      console.error(`agent payment ${payment.transaction} (${payment.protocol}, ${quote.amount} base units) settled but was not recorded:`, e);
      return { status: "paid", customerId: input.customerId ?? (wallet ? `wallet:${wallet}` : "unknown"), event: null, headers: settlementHeaders };
    }
    return { status: "paid", customerId: event.customerId, event, headers: settlementHeaders };
  }
}

type ParsedIx = { program?: string; parsed?: { type?: string; info?: { authority?: string; multisigAuthority?: string; destination?: string } } };

/**
 * The wallet that authorised the token transfer in a settled payment. pay-kit
 * reports the payer for x402 but not for MPP, so read it from the transaction.
 * Retried briefly: the transaction is confirmed, but an RPC node may lag.
 */
export async function transferAuthority(rpcUrl: string, signature: string, attempts = 5): Promise<string | undefined> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      }),
    });
    const json = (await res.json()) as { result?: { transaction: { message: { instructions: ParsedIx[] } }; meta?: { innerInstructions?: { instructions: ParsedIx[] }[] } } | null };
    const tx = json.result;
    if (tx) {
      const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
      const transfers = all.filter((ix) => ix.program?.startsWith("spl-token") && (ix.parsed?.type === "transferChecked" || ix.parsed?.type === "transfer"));
      // The first transfer is the base amount to the merchant; fee splits come after it.
      const info = transfers[0]?.parsed?.info;
      return info?.authority ?? info?.multisigAuthority;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return undefined;
}

// ------------------------------------------------------------------ configuration

const NETWORK = { test: "devnet", live: "mainnet" } as const;
const DEFAULT_RPC = { test: "https://api.devnet.solana.com", live: "https://api.mainnet-beta.solana.com" } as const;
const USDC = { test: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", live: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } as const;

function keyBytes(key: string): Uint8Array {
  const raw = key.trim().startsWith("[") ? key : readFileSync(key, "utf8");
  return Uint8Array.from(JSON.parse(raw) as number[]);
}

/**
 * Build the payment gates from the same variables as settlement (see
 * packages/settlement/src/chains.ts): per environment E in TEST and LIVE,
 * NUMMO_E_PULLER_KEY (required), NUMMO_E_RPC_URL and NUMMO_E_MINT. The puller
 * is the operator that pays network fees. Agent payments settle in USDC only, so
 * an environment with another mint is left out.
 *
 * NUMMO_MPP_SECRET binds MPP challenges to their contents. When unset it is
 * derived from the puller key, which is stable across restarts and replicas.
 */
export async function agentPaymentsFromEnv(db: Db, env: NodeJS.ProcessEnv = process.env, warn: (m: string) => void = console.warn) {
  const gates: Partial<Record<Env, PaymentGate>> = {};
  const rpcUrls: Partial<Record<Env, string>> = {};
  const replayStore = pgStore(db);
  for (const e of ["test", "live"] as const) {
    const E = e.toUpperCase();
    const key = env[`NUMMO_${E}_PULLER_KEY`];
    if (!key) continue;
    const mint = env[`NUMMO_${E}_MINT`] ?? USDC[e];
    if (mint !== USDC[e]) {
      warn(`${e}: agent payments are off, because they settle in USDC and NUMMO_${E}_MINT is ${mint}`);
      continue;
    }
    const secret = keyBytes(key);
    const mppSecret = env.NUMMO_MPP_SECRET ?? createHmac("sha256", Buffer.from(secret)).update(`nummo mpp challenge binding ${e}`).digest("hex");
    rpcUrls[e] = env[`NUMMO_${E}_RPC_URL`] ?? DEFAULT_RPC[e];
    gates[e] = await createPayKit({
      network: NETWORK[e],
      rpcUrl: rpcUrls[e],
      accept: ["x402", "mpp"],
      stablecoins: ["USDC"],
      operator: { signer: await Signer.bytes(secret), feePayer: true },
      mpp: { challengeBindingSecret: mppSecret, realm: env.NUMMO_MPP_REALM ?? "nummo" },
      replayStore,
      preflight: false,
    });
  }
  return new AgentPayments(db, gates, rpcUrls);
}

export { Store };
