/**
 * Settlement knobs. Defaults follow doc 03; every one can be overridden from
 * the environment so short devnet plans (1-hour periods) can be exercised.
 */

import { HOUR_MS, usdc } from "@usenummo/core";

export type SettlementSettings = {
  /** Collect accrued overage once it reaches this many base units (doc 03: default 5 USDC). */
  threshold: bigint;
  /**
   * Retries for a failed pull, as offsets from the first failure (doc 03: 1h, 6h,
   * 24h, 72h). After the last one fails the subscription ends.
   */
  retrySchedule: number[];
  /** Wait this long after a period boundary before pulling the renewal, so it cannot land in the old period. */
  boundaryMarginMs: number;
  /** Collect any accrued overage once the period is this close to its end. */
  closeWindowMs: (periodMs: number) => number;
  /** How long a request waits for a transaction to confirm before leaving it to the worker. */
  confirmWaitMs: number;
  /** How often to poll a signature's status while waiting. */
  pollMs: number;
  /** Public base URL of the API, used for checkout links and plan metadata. */
  publicUrl: string;
};

/** Parse "90s", "15m", "6h", "3d" or a bare number of milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new RangeError(`invalid duration ${JSON.stringify(s)}`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: HOUR_MS, d: 24 * HOUR_MS }[(m[2] ?? "ms") as "ms"];
  return n * unit;
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): SettlementSettings {
  const schedule = (env.NUMMO_RETRY_SCHEDULE ?? "1h,6h,24h,72h").split(",").map(parseDuration);
  if (schedule.length === 0 || schedule.some((v, i) => i > 0 && v <= schedule[i - 1]!)) {
    throw new RangeError("NUMMO_RETRY_SCHEDULE must be increasing offsets, e.g. 1h,6h,24h,72h");
  }
  const closeWindow = env.NUMMO_CLOSE_WINDOW ? parseDuration(env.NUMMO_CLOSE_WINDOW) : null;
  return {
    threshold: usdc(env.NUMMO_SETTLEMENT_THRESHOLD ?? "5"),
    retrySchedule: schedule,
    boundaryMarginMs: parseDuration(env.NUMMO_BOUNDARY_MARGIN ?? "60s"),
    closeWindowMs: (periodMs) => closeWindow ?? Math.min(periodMs / 10, HOUR_MS),
    confirmWaitMs: parseDuration(env.NUMMO_CONFIRM_WAIT ?? "30s"),
    pollMs: parseDuration(env.NUMMO_POLL_INTERVAL ?? "1s"),
    publicUrl: (env.NUMMO_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, ""),
  };
}

export const defaultSettings = (): SettlementSettings => settingsFromEnv({});
