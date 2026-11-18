/**
 * In-memory rate limits for the API, as token buckets: each key holds up to
 * `burst` tokens, refilled at `perSecond`; a request takes one or is refused
 * with 429 and Retry-After.
 *
 * Buckets live in this process, which suits one API instance. Behind several
 * instances each keeps its own count, so the effective limit multiplies.
 *
 * | Bucket   | Keyed by          | Default                       | Covers                                  |
 * | -------- | ----------------- | ----------------------------- | --------------------------------------- |
 * | api      | org + environment | 100/s, burst 200              | /v1/* with a valid key                  |
 * | badKey   | client IP         | 10 per minute                 | /v1/* requests with a missing/wrong key |
 * | public   | client IP         | 120 per minute, burst 120     | checkout, portal, plan metadata (GET)   |
 * | chain    | client IP         | 20 per minute                 | checkout and portal POSTs (they hit RPC)|
 * | dashboard| client IP         | 300 per minute, burst 300     | /dashboard/api/*                        |
 *
 * /api/auth/* is limited by Better Auth itself (enabled in production).
 *
 * Settings: NUMMO_RATE_LIMIT=off disables all of it. NUMMO_RATE_LIMIT_API sets
 * the per-key rate in requests per second (burst is twice that).
 * NUMMO_CLIENT_IP_HEADER names the header carrying the client's address,
 * x-real-ip by default (Railway's edge sets it). Set it to an empty string when
 * the API faces the internet with no proxy, so the socket address is used:
 * any client can forge the header otherwise.
 */

import type { Context, MiddlewareHandler } from "hono";
import { NummoError } from "@usenummo/db";

export type Rule = { perSecond: number; burst: number };
export type RateLimits = { api: Rule; badKey: Rule; public: Rule; chain: Rule; dashboard: Rule };

const perMinute = (n: number, burst = n): Rule => ({ perSecond: n / 60, burst });

export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimits | false {
  if (env.NUMMO_RATE_LIMIT === "off") return false;
  const api = Number(env.NUMMO_RATE_LIMIT_API ?? 100);
  if (!Number.isFinite(api) || api <= 0) throw new Error("NUMMO_RATE_LIMIT_API must be a positive number of requests per second");
  return {
    api: { perSecond: api, burst: api * 2 },
    badKey: perMinute(10),
    public: perMinute(120),
    chain: perMinute(20),
    dashboard: perMinute(300),
  };
}

export function clientIpHeader(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NUMMO_CLIENT_IP_HEADER ?? "x-real-ip").trim().toLowerCase();
}

/** The client's address: the configured proxy header, else the socket's address. */
export function clientIp(c: Context, header: string): string {
  if (header) {
    const v = c.req.header(header)?.split(",")[0]?.trim();
    if (v) return v;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly rule: Rule;
  private readonly now: () => number;
  constructor(rule: Rule, now: () => number = Date.now) {
    this.rule = rule;
    this.now = now;
  }

  /** Takes a token. Returns 0 when allowed, else the seconds until one is free. */
  take(key: string): number {
    const now = this.now();
    const b = this.peek(key, now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.max(1, Math.ceil((1 - b.tokens) / this.rule.perSecond));
  }

  /** Seconds until a token is free without taking one (0 if one is free now). */
  wait(key: string): number {
    const b = this.peek(key, this.now());
    return b.tokens >= 1 ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / this.rule.perSecond));
  }

  private peek(key: string, now: number) {
    const prev = this.buckets.get(key);
    if (!prev) {
      // Drop buckets that have refilled completely, so the map does not grow without bound.
      if (this.buckets.size >= 50_000) this.sweep(now);
      return { tokens: this.rule.burst, at: now };
    }
    const tokens = Math.min(this.rule.burst, prev.tokens + ((now - prev.at) / 1000) * this.rule.perSecond);
    return { tokens, at: now };
  }

  private sweep(now: number) {
    const full = (this.rule.burst / this.rule.perSecond) * 1000;
    for (const [k, b] of this.buckets) if (now - b.at >= full) this.buckets.delete(k);
  }
}

export function limited(retryAfter: number): never {
  throw new NummoError("rate_limited", `too many requests; retry in ${retryAfter}s`, { retryAfter });
}

/** Middleware that limits by client IP with the given buckets. */
export function limitByIp(buckets: TokenBuckets, ipHeader: string): MiddlewareHandler {
  return async (c, next) => {
    const wait = buckets.take(clientIp(c, ipHeader));
    if (wait) limited(wait);
    await next();
  };
}
