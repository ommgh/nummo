import { describe, expect, test } from "vitest";
import { createMailer, passwordResetMail } from "../src/mail.ts";
import { rateLimitsFromEnv, TokenBuckets } from "../src/rate-limit.ts";

describe("token buckets", () => {
  test("allow the burst, refuse the next, refill over time", () => {
    let now = 0;
    const b = new TokenBuckets({ perSecond: 1, burst: 3 }, () => now);
    expect([b.take("a"), b.take("a"), b.take("a")]).toEqual([0, 0, 0]);
    expect(b.take("a")).toBe(1);
    expect(b.take("b")).toBe(0); // keys are independent
    now += 1000;
    expect(b.take("a")).toBe(0);
    expect(b.take("a")).toBe(1);
  });

  test("report whole seconds until the next token", () => {
    let now = 0;
    const b = new TokenBuckets({ perSecond: 10 / 60, burst: 1 }, () => now);
    expect(b.take("ip")).toBe(0);
    expect(b.take("ip")).toBe(6);
    now += 3000;
    expect(b.wait("ip")).toBe(3);
  });

  test("never hold more than the burst", () => {
    let now = 0;
    const b = new TokenBuckets({ perSecond: 100, burst: 2 }, () => now);
    now += 60_000;
    expect([b.take("a"), b.take("a")]).toEqual([0, 0]);
    expect(b.take("a")).toBeGreaterThan(0);
  });
});

describe("rate limit settings", () => {
  test("defaults, override and off", () => {
    expect(rateLimitsFromEnv({})).toMatchObject({ api: { perSecond: 100, burst: 200 }, badKey: { burst: 10 } });
    expect(rateLimitsFromEnv({ NUMMO_RATE_LIMIT_API: "5" })).toMatchObject({ api: { perSecond: 5, burst: 10 } });
    expect(rateLimitsFromEnv({ NUMMO_RATE_LIMIT: "off" })).toBe(false);
    expect(() => rateLimitsFromEnv({ NUMMO_RATE_LIMIT_API: "lots" })).toThrow(/NUMMO_RATE_LIMIT_API/);
  });
});

describe("mailer", () => {
  const mail = passwordResetMail({ to: "a@example.com", name: "Ada <script>", url: "https://nummo.test/api/auth/reset-password/tok?callbackURL=%2Freset-password" });

  test("the reset email carries the link and escapes the name", () => {
    expect(mail.subject).toBe("Reset your nummo password");
    expect(mail.text).toContain("https://nummo.test/api/auth/reset-password/tok");
    expect(mail.html).toContain("Ada &lt;script&gt;");
    expect(mail.html).not.toContain("<script>");
  });

  test("Resend is called over HTTP with the sender", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const m = createMailer({ RESEND_API_KEY: "re_x", MAIL_FROM: "nummo <no-reply@nummo.test>" }, fake);
    expect(m.kind).toBe("resend");
    await m.send(mail);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_x");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ from: "nummo <no-reply@nummo.test>", to: ["a@example.com"] });
  });

  test("a refused send throws", async () => {
    const fake = (async () => new Response("bad domain", { status: 403 })) as unknown as typeof fetch;
    await expect(createMailer({ RESEND_API_KEY: "re_x", MAIL_FROM: "x@y.z" }, fake).send(mail)).rejects.toThrow(/403/);
  });

  test("picks SMTP, the console, or nothing", () => {
    expect(createMailer({ SMTP_URL: "smtp://u:p@localhost:2525", MAIL_FROM: "x@y.z" }).kind).toBe("smtp");
    expect(createMailer({}).kind).toBe("console");
    expect(createMailer({ NODE_ENV: "production" }).kind).toBe("none");
    expect(() => createMailer({ SMTP_URL: "smtp://localhost" })).toThrow(/MAIL_FROM/);
  });
});
