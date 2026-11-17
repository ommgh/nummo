/**
 * Billing periods are a fixed number of hours, matching the on-chain program
 * (doc 03, fact 6). Periods are anchored: the k-th period starts at
 * anchor + k * length. This is the same arithmetic the Subscriptions program
 * uses when it advances `current_period_start_ts`.
 */

export const HOUR_MS = 3_600_000;

export type Period = { start: Date; end: Date };

export function periodAt(anchor: Date, hours: number, now: Date): Period {
  if (!Number.isInteger(hours) || hours <= 0) throw new RangeError(`period hours must be a positive integer, got ${hours}`);
  const len = hours * HOUR_MS;
  const elapsed = now.getTime() - anchor.getTime();
  const k = elapsed <= 0 ? 0 : Math.floor(elapsed / len);
  const start = anchor.getTime() + k * len;
  return { start: new Date(start), end: new Date(start + len) };
}

/** Parse a duration like "30d", "12h" or a bare number of hours. */
export function parseHours(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) throw new RangeError(`invalid hours: ${value}`);
    return value;
  }
  const m = /^(\d+)\s*([dh])$/.exec(value.trim());
  if (!m) throw new RangeError(`invalid duration ${JSON.stringify(value)}; use "30d" or "12h"`);
  const n = Number(m[1]);
  const hours = m[2] === "d" ? n * 24 : n;
  if (hours <= 0) throw new RangeError(`duration must be positive: ${value}`);
  return hours;
}

/** "every 30 days" rather than "monthly": there are no calendar months on-chain. */
export function describePeriod(hours: number): string {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return d === 1 ? "every day" : `every ${d} days`;
  }
  return hours === 1 ? "every hour" : `every ${hours} hours`;
}
