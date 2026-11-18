import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { createApiKey, createDb, createOrg, runMigrations } from "@usenummo/db";
import { settingsFromEnv } from "@usenummo/settlement";
import { Nummo } from "@usenummo/sdk";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import type { Mail } from "../src/mail.ts";

const { db, close } = createDb();
const servers: ServerType[] = [];
const sent: Mail[] = [];

async function start(app: ReturnType<typeof createApp>) {
  const server = serve({ fetch: app.fetch, port: 0 });
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const never = 1e-9; // per second: no refill during a test
let limitedUrl: string;
let authUrl: string;
let key: string;

beforeAll(async () => {
  await runMigrations(db);
  const orgId = await createOrg(db, "limits test");
  key = (await createApiKey(db, orgId, "test")).key;
  limitedUrl = await start(
    createApp(db, {
      rateLimits: {
        api: { perSecond: never, burst: 3 },
        badKey: { perSecond: never, burst: 2 },
        public: { perSecond: never, burst: 2 },
        chain: { perSecond: never, burst: 1 },
        dashboard: { perSecond: never, burst: 50 },
      },
    }),
  );
  // Auth needs its own public URL to build the reset link; the port is only known after listening.
  const server = serve({ fetch: (req) => authApp!.fetch(req), port: 0 });
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  authUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = createAuth(db, { publicUrl: authUrl, mailer: { kind: "console", send: async (m) => void sent.push(m) } });
  authApp = createApp(db, { auth, rateLimits: false, settings: { ...settingsFromEnv(), publicUrl: authUrl } });
});
let authApp: ReturnType<typeof createApp> | undefined;

afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await close();
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("rate limits over HTTP", () => {
  test("a key past its burst gets 429 with Retry-After; the SDK fails open and queues", async () => {
    const auth = { authorization: `Bearer ${key}` };
    for (let i = 0; i < 3; i++) expect((await post(`${limitedUrl}/v1/check`, { customerId: "rl", featureId: "x" }, auth)).status).not.toBe(429);
    const res = await post(`${limitedUrl}/v1/check`, { customerId: "rl", featureId: "x" }, auth);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await res.json()).error.code).toBe("rate_limited");

    const nummo = new Nummo({ secretKey: key, baseUrl: limitedUrl });
    expect(await nummo.check({ customerId: "rl", featureId: "x" })).toMatchObject({ allowed: true, failedOpen: true });
    expect(await nummo.track({ customerId: "rl", featureId: "x", value: 1 })).toBeNull();
    expect(nummo.pending).toBe(1);
  });

  test("wrong keys are cut off per IP, and a valid key from the same IP is not", async () => {
    const bad = { authorization: "Bearer nummo_sk_test_wrong" };
    expect((await post(`${limitedUrl}/v1/check`, {}, bad)).status).toBe(401);
    expect((await post(`${limitedUrl}/v1/check`, {}, bad)).status).toBe(401);
    expect((await post(`${limitedUrl}/v1/check`, {}, bad)).status).toBe(429);
    const other = (await createApiKey(db, await createOrg(db, "limits other"), "test")).key;
    expect((await post(`${limitedUrl}/v1/check`, { customerId: "rl2", featureId: "x" }, { authorization: `Bearer ${other}` })).status).not.toBe(429);
  });

  test("public pages are limited per IP, reads and writes separately", async () => {
    expect((await fetch(`${limitedUrl}/checkout/nope/session`)).status).toBe(404);
    expect((await fetch(`${limitedUrl}/portal/nope/data`)).status).toBe(404);
    expect((await fetch(`${limitedUrl}/checkout/nope/session`)).status).toBe(429);
    expect((await post(`${limitedUrl}/checkout/nope/submit`, { signedTransaction: "x" })).status).not.toBe(429);
    expect((await post(`${limitedUrl}/checkout/nope/submit`, { signedTransaction: "x" })).status).toBe(429);
  });

  test("the client IP comes from X-Real-IP", async () => {
    // A fresh address has its own bucket, even after the tests above used up 127.0.0.1's.
    expect((await fetch(`${limitedUrl}/checkout/nope/session`, { headers: { "x-real-ip": "203.0.113.7" } })).status).toBe(404);
  });

  test("health and the website are never limited", async () => {
    for (let i = 0; i < 5; i++) expect((await fetch(`${limitedUrl}/health`)).status).toBe(200);
    const deep = await fetch(`${limitedUrl}/health/deep`);
    expect(deep.status).toBe(200);
    expect(await deep.json()).toMatchObject({ ok: true, db: "ok" });
  });
});

describe("password reset", () => {
  const email = `reset-${Date.now()}@example.com`;
  const headers = () => ({ origin: authUrl });

  test("request, email, link, new password, old one refused", async () => {
    const signUp = await post(`${authUrl}/api/auth/sign-up/email`, { email, password: "first-password-1", name: "Reset Tester" }, headers());
    expect(signUp.status).toBe(200);

    const req = await post(`${authUrl}/api/auth/request-password-reset`, { email, redirectTo: "/reset-password" }, headers());
    expect(req.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const mail = sent.find((m) => m.to === email);
    expect(mail?.subject).toBe("Reset your nummo password");
    const link = mail!.text.match(/https?:\/\/\S+reset-password\/\S+/)![0];

    const hop = await fetch(link, { redirect: "manual" });
    expect(hop.status).toBe(302);
    const target = new URL(hop.headers.get("location")!, authUrl);
    expect(target.pathname).toBe("/reset-password");
    const token = target.searchParams.get("token")!;
    expect(token).toBeTruthy();

    expect((await post(`${authUrl}/api/auth/reset-password`, { newPassword: "second-password-2", token }, headers())).status).toBe(200);
    // The token works once.
    expect((await post(`${authUrl}/api/auth/reset-password`, { newPassword: "third-password-3", token }, headers())).status).toBe(400);

    expect((await post(`${authUrl}/api/auth/sign-in/email`, { email, password: "first-password-1" }, headers())).status).toBe(401);
    expect((await post(`${authUrl}/api/auth/sign-in/email`, { email, password: "second-password-2" }, headers())).status).toBe(200);
  });

  test("an unknown address answers the same and sends nothing", async () => {
    const before = sent.length;
    const res = await post(`${authUrl}/api/auth/request-password-reset`, { email: "nobody-here@example.com", redirectTo: "/reset-password" }, headers());
    expect(res.status).toBe(200);
    expect(sent.length).toBe(before);
  });

  test("an expired or made-up token lands on the page with an error", async () => {
    const hop = await fetch(`${authUrl}/api/auth/reset-password/made-up?callbackURL=%2Freset-password`, { redirect: "manual" });
    expect(new URL(hop.headers.get("location")!, authUrl).searchParams.get("error")).toBe("INVALID_TOKEN");
  });
});
