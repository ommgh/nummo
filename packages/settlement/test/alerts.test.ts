import { describe, expect, test } from "vitest";
import { FakeChain } from "@usenummo/solana/testing";
import { type Alert, alertSettingsFromEnv, Alerts, webhookBody } from "../src/alerts.ts";

function setup(env: NodeJS.ProcessEnv = {}) {
  let now = 0;
  const sent: Alert[] = [];
  const pings: string[] = [];
  const alerts = new Alerts({
    settings: alertSettingsFromEnv(env),
    sink: async (a) => void sent.push(a),
    log: () => {},
    fetch: (async (url: string) => (pings.push(url), new Response("ok"))) as unknown as typeof fetch,
    now: () => now,
  });
  return { alerts, sent, pings, tick: (ms: number) => (now += ms) };
}

describe("puller balance alerts", () => {
  test("fire once when low, repeat after 12 hours, clear when funded", async () => {
    const { alerts, sent, tick } = setup();
    const chain = new FakeChain();
    chain.solBalances.set(chain.pullerAddress, 20_000_000n); // 0.02 SOL, below the 0.05 default
    await alerts.checkPullers({ live: chain });
    await alerts.checkPullers({ live: chain });
    expect(sent.map((a) => [a.severity, a.title])).toEqual([["warning", "the live puller is low on SOL"]]);
    expect(sent[0]!.detail).toContain("0.0200 SOL");

    tick(12 * 3600_000);
    await alerts.checkPullers({ live: chain });
    expect(sent).toHaveLength(2);

    chain.solBalances.set(chain.pullerAddress, 500_000_000n);
    await alerts.checkPullers({ live: chain });
    expect(sent.at(-1)).toMatchObject({ severity: "resolved", title: "the live puller is funded again" });
    await alerts.checkPullers({ live: chain });
    expect(sent).toHaveLength(3);
  });

  test("nearly empty is critical; the threshold is configurable", async () => {
    const { alerts, sent } = setup({ NUMMO_ALERT_MIN_SOL: "0.5" });
    const chain = new FakeChain();
    chain.solBalances.set(chain.pullerAddress, 50_000_000n); // 0.05 < 0.5 / 5
    await alerts.checkPullers({ test: chain });
    expect(sent[0]).toMatchObject({ severity: "critical", key: "puller:test" });
  });
});

describe("loop failure alerts", () => {
  test("three failures in a row raise one alert; a success clears it", async () => {
    const { alerts, sent } = setup();
    const boom = new Error("connect ECONNREFUSED");
    await alerts.loopResult("settle", boom);
    await alerts.loopResult("settle", null);
    await alerts.loopResult("settle", boom);
    await alerts.loopResult("settle", boom);
    expect(sent).toHaveLength(0);
    await alerts.loopResult("settle", boom);
    await alerts.loopResult("settle", boom);
    expect(sent.map((a) => a.severity)).toEqual(["critical"]);
    expect(sent[0]!.detail).toContain("ECONNREFUSED");
    await alerts.loopResult("settle", null);
    expect(sent.map((a) => a.severity)).toEqual(["critical", "resolved"]);
  });
});

describe("heartbeat", () => {
  test("pings at most once a minute, and only when configured", async () => {
    const off = setup();
    await off.alerts.heartbeat();
    expect(off.pings).toHaveLength(0);

    const { alerts, pings, tick } = setup({ NUMMO_HEARTBEAT_URL: "https://hc-ping.com/abc" });
    await alerts.heartbeat();
    tick(30_000);
    await alerts.heartbeat();
    tick(30_000);
    await alerts.heartbeat();
    expect(pings).toEqual(["https://hc-ping.com/abc", "https://hc-ping.com/abc"]);
  });
});

describe("webhook formats", () => {
  const a: Alert = { key: "k", severity: "critical", title: "the live puller is low on SOL", detail: "send SOL" };
  test("Discord, Slack, ntfy and plain JSON", () => {
    expect(JSON.parse(webhookBody("https://discord.com/api/webhooks/1/x", a).body)).toEqual({ content: "🚨 nummo: the live puller is low on SOL\nsend SOL" });
    expect(JSON.parse(webhookBody("https://hooks.slack.com/services/x", a).body)).toHaveProperty("text");
    const ntfy = webhookBody("https://ntfy.sh/my-topic", a);
    expect(ntfy).toMatchObject({ body: "send SOL", contentType: "text/plain", headers: { priority: "high" } });
    expect(JSON.parse(webhookBody("https://example.com/hook", a).body)).toMatchObject({ severity: "critical", key: "k" });
  });
});
