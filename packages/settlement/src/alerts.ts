/**
 * Operational alerts from the worker, for the failures no outside monitor can
 * see. Each one fires once when it starts and once more when it clears.
 *
 * - The puller's SOL balance falls below NUMMO_ALERT_MIN_SOL (default 0.05).
 *   The puller pays every network fee and the rent of new subscriber records,
 *   so an empty puller quietly stops renewals, overage, checkouts and agent
 *   payments.
 * - A worker loop (settle, reconcile, dispatch) fails three times in a row:
 *   the database or the RPC endpoint is down, or a bug.
 *
 * NUMMO_ALERT_WEBHOOK_URL says where alerts go: a Discord or Slack incoming
 * webhook, an ntfy.sh topic (phone push), or any URL that takes JSON.
 * Without it alerts are only logged.
 *
 * NUMMO_HEARTBEAT_URL is pinged (GET) at most once a minute after a settlement
 * pass completes. Point it at a dead-man's switch such as Healthchecks.io: if
 * the pings stop because the worker crashed or hangs, that service alerts you.
 */

import type { Chains } from "./chains.ts";

export type Alert = { key: string; title: string; detail: string; severity: "warning" | "critical" | "resolved" };
export type AlertSink = (alert: Alert) => Promise<void>;

const LAMPORTS_PER_SOL = 1_000_000_000;

export type AlertSettings = {
  webhookUrl: string | null;
  heartbeatUrl: string | null;
  minSolLamports: bigint;
  /** Repeat a still-active alert after this long. */
  repeatMs: number;
};

export function alertSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AlertSettings {
  const minSol = Number(env.NUMMO_ALERT_MIN_SOL ?? 0.05);
  if (!Number.isFinite(minSol) || minSol < 0) throw new Error("NUMMO_ALERT_MIN_SOL must be a number of SOL");
  return {
    webhookUrl: env.NUMMO_ALERT_WEBHOOK_URL?.trim() || null,
    heartbeatUrl: env.NUMMO_HEARTBEAT_URL?.trim() || null,
    minSolLamports: BigInt(Math.round(minSol * LAMPORTS_PER_SOL)),
    repeatMs: 12 * 3600_000,
  };
}

const ICON = { warning: "⚠️", critical: "🚨", resolved: "✅" } as const;

/** Formats the alert for the kind of webhook the URL points at. */
export function webhookBody(url: string, a: Alert): { body: string; contentType: string; headers?: Record<string, string> } {
  const text = `${ICON[a.severity]} nummo: ${a.title}\n${a.detail}`;
  const host = new URL(url).hostname;
  if (host === "discord.com" || host.endsWith(".discord.com") || host === "discordapp.com") return { body: JSON.stringify({ content: text }), contentType: "application/json" };
  if (host === "hooks.slack.com") return { body: JSON.stringify({ text }), contentType: "application/json" };
  if (host === "ntfy.sh" || host.startsWith("ntfy.")) {
    return { body: a.detail, contentType: "text/plain", headers: { title: `nummo: ${a.title}`, priority: a.severity === "critical" ? "high" : "default", tags: a.severity === "resolved" ? "white_check_mark" : "warning" } };
  }
  return { body: JSON.stringify({ text, ...a }), contentType: "application/json" };
}

export function webhookSink(url: string, fetchImpl: typeof fetch = fetch): AlertSink {
  return async (a) => {
    const { body, contentType, headers } = webhookBody(url, a);
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": contentType, ...headers }, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`alert webhook answered ${res.status}`);
  };
}

/** Tracks which alerts are active, so each fires once and clears once. */
export class Alerts {
  private readonly active = new Map<string, { since: number; lastSent: number }>();
  private readonly failures = new Map<string, number>();
  private lastHeartbeat = Number.NEGATIVE_INFINITY;
  private readonly settings: AlertSettings;
  private readonly sink: AlertSink;
  private readonly log: (msg: string, data?: unknown) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: { settings: AlertSettings; sink?: AlertSink; log?: (msg: string, data?: unknown) => void; fetch?: typeof fetch; now?: () => number }) {
    this.settings = opts.settings;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sink = opts.sink ?? (opts.settings.webhookUrl ? webhookSink(opts.settings.webhookUrl, this.fetchImpl) : async () => {});
    this.log = opts.log ?? ((m, d) => console.log(new Date().toISOString(), m, d === undefined ? "" : JSON.stringify(d)));
    this.now = opts.now ?? Date.now;
  }

  /** Raise (or keep raised) an alert. Sends when new, then again every `repeatMs`. */
  async raise(key: string, severity: "warning" | "critical", title: string, detail: string) {
    const now = this.now();
    const a = this.active.get(key);
    if (a && now - a.lastSent < this.settings.repeatMs) return;
    this.active.set(key, { since: a?.since ?? now, lastSent: now });
    await this.send({ key, severity, title, detail });
  }

  /** Clear an alert if it is active, and say so. */
  async clear(key: string, title: string, detail: string) {
    if (!this.active.delete(key)) return;
    await this.send({ key, severity: "resolved", title, detail });
  }

  isActive(key: string) {
    return this.active.has(key);
  }

  /** Feed each worker loop's outcome; three failures in a row raise an alert. */
  async loopResult(name: string, error: Error | null) {
    const key = `loop:${name}`;
    if (!error) {
      this.failures.set(name, 0);
      await this.clear(key, `the ${name} loop recovered`, `The worker's ${name} loop is running again.`);
      return;
    }
    const n = (this.failures.get(name) ?? 0) + 1;
    this.failures.set(name, n);
    if (n >= 3) await this.raise(key, "critical", `the ${name} loop is failing`, `${n} passes in a row failed. Last error: ${error.message.slice(0, 500)}`);
  }

  /** Check each puller's SOL balance. */
  async checkPullers(chains: Chains) {
    const min = this.settings.minSolLamports;
    for (const [env, chain] of Object.entries(chains)) {
      if (!chain) continue;
      const key = `puller:${env}`;
      let lamports: bigint;
      try {
        lamports = await chain.getSolBalance(chain.pullerAddress);
      } catch (e) {
        this.log("puller balance check failed", { env, error: (e as Error).message });
        continue;
      }
      const sol = (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
      const where = `${env} puller ${chain.pullerAddress} on ${chain.network}`;
      if (lamports < min) {
        await this.raise(
          key,
          lamports < min / 5n ? "critical" : "warning",
          `the ${env} puller is low on SOL`,
          `${where} holds ${sol} SOL (alert below ${Number(min) / LAMPORTS_PER_SOL}). It pays every fee and each new subscriber's rent (about 0.0026 SOL); when it runs out, renewals, overage collection, checkouts and agent payments stop. Send it SOL.`,
        );
      } else {
        await this.clear(key, `the ${env} puller is funded again`, `${where} holds ${sol} SOL.`);
      }
    }
  }

  /** Ping the heartbeat URL, at most once a minute. */
  async heartbeat() {
    const url = this.settings.heartbeatUrl;
    const now = this.now();
    if (!url || now - this.lastHeartbeat < 60_000) return;
    this.lastHeartbeat = now;
    try {
      await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      this.log("heartbeat ping failed", { error: (e as Error).message });
    }
  }

  private async send(a: Alert) {
    this.log(`alert ${a.severity}: ${a.title}`, { detail: a.detail });
    try {
      await this.sink(a);
    } catch (e) {
      this.log("alert delivery failed", { error: (e as Error).message });
    }
  }
}
