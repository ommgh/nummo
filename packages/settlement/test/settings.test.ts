import { expect, test } from "vitest";
import { backoffMs, parseDuration, settingsFromEnv } from "../src/index.ts";

test("durations and defaults", () => {
  expect(parseDuration("90s")).toBe(90_000);
  expect(parseDuration("6h")).toBe(21_600_000);
  const s = settingsFromEnv({});
  expect(s.threshold).toBe(5_000_000n);
  expect(s.retrySchedule).toEqual([1, 6, 24, 72].map((h) => h * 3_600_000));
  expect(s.closeWindowMs(720 * 3_600_000)).toBe(3_600_000);
  expect(s.closeWindowMs(3_600_000)).toBe(360_000);
  expect(() => settingsFromEnv({ NUMMO_RETRY_SCHEDULE: "6h,1h" })).toThrow();
  expect(backoffMs(1)).toBe(10_000);
  expect(backoffMs(30)).toBe(6 * 3_600_000);
});

test("mainnet chain: USDC only unless allowed, priority fee by default, warnings", async () => {
  const { chainsFromEnv } = await import("../src/index.ts");
  // A real keypair: loadKeypair checks the public key matches the seed.
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = JSON.stringify([
    ...Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url"),
    ...Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url"),
  ]);
  const warnings: string[] = [];
  const chains = await chainsFromEnv({ NUMMO_LIVE_PULLER_KEY: key }, (m) => warnings.push(m));
  expect(chains.live?.network).toBe("mainnet");
  expect(chains.live?.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  expect(warnings.join(" ")).toContain("public mainnet RPC");
  expect(warnings.join(" ")).not.toContain("priority fee");
  await expect(chainsFromEnv({ NUMMO_LIVE_PULLER_KEY: key, NUMMO_LIVE_MINT: "So11111111111111111111111111111111111111112" }, () => {})).rejects.toThrow(/not mainnet USDC/);
  const zero: string[] = [];
  await chainsFromEnv({ NUMMO_LIVE_PULLER_KEY: key, NUMMO_LIVE_PRIORITY_FEE: "0", NUMMO_LIVE_RPC_URL: "https://rpc.example" }, (m) => zero.push(m));
  expect(zero).toEqual([expect.stringContaining("no priority fee")]);
});
