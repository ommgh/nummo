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
