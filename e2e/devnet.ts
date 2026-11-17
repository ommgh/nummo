// End-to-end settlement scenarios on Solana devnet (milestone M2, doc 05).
//
//   node e2e/devnet.ts run        activation x3, overage, failed payment, cancellation, webhooks, verify
//   node e2e/devnet.ts renewal    after the 1-hour period: renewal pull, cancellation takes effect, verify
//
// Runs the real API in-process against the local Postgres, drives the real CLI
// (`nummo push`, `nummo plans publish`, `nummo verify`) as subprocesses, and acts
// as three customer wallets that hold USDC and no SOL. Settlement passes are run
// directly (the same functions the worker loops over).
//
// Needs: Postgres (pnpm db:up), the funded spike wallets in spikes/.keys
// (merchant: owns the plan and the test mint; puller: pays fees and rent).
// Uses a 6-decimal test mint the merchant controls, standing in for devnet USDC.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  type KeyPairSigner,
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  signature as toSignature,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token";
import { getCancelSubscriptionOverlayInstructionAsync } from "@solana/subscriptions";
import { createApp } from "@usenummo/api";
import { usdc } from "@usenummo/config";
import { createApiKey, createDb, createOrg, ensureDatabase, runMigrations } from "@usenummo/db";
import { Nummo, verifyWebhook } from "@usenummo/sdk";
import { dispatchTick, reconcileTick, type SettlementSettings, settlementTick, settingsFromEnv } from "@usenummo/settlement";
import { loadKeypair, sendAndConfirm, SolanaChain, withRateLimitRetry as rl } from "@usenummo/solana";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;
const KEYS = `${HERE}.keys`;
const STATE_FILE = `${HERE}devnet.state.json`;
const RPC_URL = process.env.NUMMO_TEST_RPC_URL ?? "https://api.devnet.solana.com";
const U = 1_000_000n;
const rpc = createSolanaRpc(RPC_URL);
// Its own database: the settlement passes below settle every org in the test environment.
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://nummo:nummo@localhost:5434/nummo_e2e";

type Customer = { name: string; wallet: string; key: string; subscriptionId?: string; activation?: string };
type State = { orgId: string; apiKey: string; mint: string; customers: Record<string, Customer>; aliceAnchor?: string; carolCancelAt?: string };

// ---------------------------------------------------------------- output

let failures = 0;
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
function check(cond: boolean, what: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) failures++;
}
const fmt = (b: bigint) => (Number(b) / 1e6).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- keys and tokens

async function newKey(path: string): Promise<KeyPairSigner> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const bytes = new Uint8Array([...pkcs8.slice(-32), ...pub]);
  writeFileSync(path, JSON.stringify([...bytes]));
  return createKeyPairSignerFromBytes(bytes);
}

async function sol(a: string) {
  return (await rl(() => rpc.getBalance(address(a), { commitment: "confirmed" }).send())).value;
}

async function tokenBalance(mint: string, owner: string) {
  const [ata] = await findAssociatedTokenPda({ mint: address(mint), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  try {
    return BigInt((await rl(() => rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send())).value.amount);
  } catch {
    return 0n;
  }
}

async function createMint(merchant: KeyPairSigner) {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const lamports = await rl(() => rpc.getMinimumBalanceForRentExemption(space).send());
  await sendAndConfirm(rpc, merchant, [
    getCreateAccountInstruction({ payer: merchant, newAccount: mint, lamports, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: merchant.address }),
  ]);
  return mint.address;
}

async function mintTo(merchant: KeyPairSigner, mint: string, owner: string, amount: bigint) {
  const [ata] = await findAssociatedTokenPda({ mint: address(mint), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await sendAndConfirm(rpc, merchant, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: merchant, owner: address(owner), mint: address(mint) }),
    getMintToInstruction({ mint: address(mint), token: ata, mintAuthority: merchant, amount }),
  ]);
}

async function computeUnits(sig: string) {
  const tx = await rl(() =>
    rpc.getTransaction(toSignature(sig), { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }).send(),
  );
  return tx?.meta?.computeUnitsConsumed;
}

// ---------------------------------------------------------------- harness

/** Run the CLI as a subprocess. Async, so the in-process API keeps serving it. */
function cli(env: Record<string, string>, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [`${ROOT}packages/cli/src/main.ts`, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      for (const line of out.trim().split("\n")) console.log(`    | ${line}`);
      resolve({ code: code ?? 1, out });
    });
  });
}

async function harness(state: Pick<State, "mint">) {
  const puller = await loadKeypair(`${KEYS}/puller.json`);
  const chain = new SolanaChain({ network: "devnet", rpcUrl: RPC_URL, puller, mint: state.mint });
  const settings: SettlementSettings = {
    ...settingsFromEnv({}),
    threshold: usdc("1"),
    retrySchedule: [20_000, 40_000, 60_000],
    boundaryMarginMs: 45_000,
    confirmWaitMs: 60_000,
    pollMs: 1_500,
  };
  await ensureDatabase(DATABASE_URL);
  const { db, close } = createDb(DATABASE_URL);
  await runMigrations(db);
  const chains = { test: chain };
  const server = serve({ fetch: createApp(db, { chains, settings }).fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  settings.publicUrl = apiUrl;

  // A local webhook receiver.
  const hooks: { body: string; sig: string | null }[] = [];
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hooks.push({ body, sig: (req.headers["x-nummo-signature"] as string) ?? null });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;

  const shutdown = async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => receiver.close(r));
    await close();
  };
  return { puller, chain, chains, settings, db, apiUrl, hooks, hookUrl, shutdown };
}

async function checkoutAs(apiUrl: string, checkoutUrl: string, customer: KeyPairSigner) {
  const id = checkoutUrl.split("/").pop()!;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`${apiUrl}/checkout/${id}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = (await r.json()) as Record<string, any>;
    if (!r.ok) throw new Error(`${path}: ${j.error?.message ?? r.status}`);
    return j;
  };
  const session = await call("/session");
  const { transaction, createsAuthority } = await call("/transaction", { wallet: customer.address });
  // What a browser wallet does: sign the bytes it was given, without broadcasting.
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const signed = await partiallySignTransaction([customer.keyPair], tx as Parameters<typeof partiallySignTransaction>[1]);
  const done = await call("/submit", { signedTransaction: getBase64EncodedWireTransaction(signed) });
  return { session, done, createsAuthority };
}

// ---------------------------------------------------------------- phase: run

async function run() {
  mkdirSync(KEYS, { recursive: true });
  for (const k of ["merchant", "puller"]) {
    if (!existsSync(`${KEYS}/${k}.json`)) copyFileSync(`${ROOT}spikes/.keys/${k}.json`, `${KEYS}/${k}.json`);
  }
  const merchant = await loadKeypair(`${KEYS}/merchant.json`);
  const pullerKey = await loadKeypair(`${KEYS}/puller.json`);
  log(`merchant ${merchant.address} (${Number(await sol(merchant.address)) / 1e9} SOL)`);
  log(`puller   ${pullerKey.address} (${Number(await sol(pullerKey.address)) / 1e9} SOL)`);
  if ((await sol(pullerKey.address)) < 30_000_000n) throw new Error("the puller needs at least 0.03 devnet SOL");

  log("creating a 6-decimal test mint and three customer wallets with no SOL");
  const mint = await createMint(merchant);
  const runDir = `${KEYS}/run-${Date.now()}`;
  mkdirSync(runDir);
  const funding: Record<string, bigint> = { alice: 30n * U, bob: 2n * U + U / 2n, carol: 10n * U };
  const customers: Record<string, Customer> = {};
  const signers: Record<string, KeyPairSigner> = {};
  for (const [name, amount] of Object.entries(funding)) {
    const key = `${runDir}/${name}.json`;
    signers[name] = await newKey(key);
    await mintTo(merchant, mint, signers[name].address, amount);
    customers[name] = { name, wallet: signers[name].address, key };
    log(`  ${name.padEnd(5)} ${signers[name].address} holds ${fmt(amount)} USDC`);
  }

  const { db, chains, settings, apiUrl, hooks, hookUrl, shutdown, chain } = await harness({ mint });
  const orgId = await createOrg(db, `e2e devnet ${new Date().toISOString()}`);
  const { key: apiKey } = await createApiKey(db, orgId, "test");
  const state: State = { orgId, apiKey, mint, customers };
  const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  save();
  const env = { NUMMO_SECRET_KEY: apiKey, NUMMO_API_URL: apiUrl };
  const nummo = new Nummo({ secretKey: apiKey, baseUrl: apiUrl, timeoutMs: 120_000 });
  const tick = async () => settlementTick(db, chains, settings);

  try {
    log("nummo push");
    check((await cli(env, "push", "--config", "e2e/nummo.config.ts", "--yes")).code === 0, "config pushed with the CLI");
    log("nummo plans publish");
    check((await cli(env, "plans", "publish", "--keypair", `${KEYS}/merchant.json`, "--yes")).code === 0, "on-chain plan created and registered with the CLI");
    const plans = await nummo.plans.list();
    const pro = plans.versions.find((v) => v.planId === "pro")!;
    check(pro.published !== null && pro.onchainTerms!.ceiling === "7", `pro@1 published at ${pro.published?.address} with a 7 USDC ceiling per hour`);
    await nummo.webhooks.set(hookUrl);

    // ---- Activation: one signature, no SOL
    log("activation: each customer signs once; the puller pays fees and rent");
    for (const name of ["alice", "bob", "carol"]) {
      const c = customers[name]!;
      const solBefore = await sol(c.wallet);
      const pullerBefore = await sol(chain.pullerAddress);
      const a = await nummo.attach({ customerId: name, planId: "pro", successUrl: "https://merchant.example/billing?ok=1" });
      const { session, done, createsAuthority } = await checkoutAs(apiUrl, a.checkoutUrl!, signers[name]!);
      c.subscriptionId = a.subscriptionId;
      c.activation = done.signature;
      save();
      check(session.onchain?.ceiling === "7" && session.onchain?.period === "every hour", `${name}: checkout shows the ceiling read from the chain`);
      check(done.status === "completed", `${name}: activation confirmed (${done.signature})`);
      check(createsAuthority === true, `${name}: transaction created the wallet's subscription authority`);
      check(solBefore === 0n && (await sol(c.wallet)) === 0n, `${name}: wallet held and spent no SOL`);
      log(`  puller spent ${Number(pullerBefore - (await sol(chain.pullerAddress))) / 1e9} SOL; activation used ${await computeUnits(done.signature)} CUs`);
    }
    const alice = await nummo.customers.get("alice");
    state.aliceAnchor = alice.subscriptions.find((s) => s.planId === "pro")!.currentPeriodStart!;
    save();
    check(alice.subscriptions.filter((s) => s.status === "active").map((s) => s.planId).join() === "pro", "alice: on pro; the free plan was replaced");
    check(alice.balances.find((b) => b.featureId === "credits")?.balance === "100", "alice: 100 credits issued");
    check((await tokenBalance(mint, merchant.address)) === 6n * U, "merchant received 3 x 2 USDC");
    let v = await nummo.verify();
    check(v.ok, `verify: no drift after activation (${v.differences.length} notices)`);

    // ---- Overage collection at the threshold
    log("overage: alice uses 250 credits (150 over, 1.50 USDC; threshold 1 USDC)");
    await nummo.track({ customerId: "alice", featureId: "message", value: 250 });
    await tick();
    const aliceInv = (await nummo.customers.invoices("alice")).invoices;
    const ov = aliceInv.find((i) => i.kind === "overage");
    check(ov?.status === "paid" && ov.total === "1.5", `alice: overage invoice of 1.5 USDC paid (${ov?.payments[0]?.signature})`);
    if (ov?.payments[0]) log(`  pull used ${await computeUnits(ov.payments[0].signature)} CUs`);
    check((await tokenBalance(mint, merchant.address)) === 7n * U + U / 2n, "merchant balance is 7.5 USDC");
    v = await nummo.verify();
    check(v.ok, "verify: no drift after overage collection");

    // ---- Failed payment: past due, retries, ended, back to free
    log("failed payment: bob holds 0.50 USDC and owes 1.50 USDC of overage");
    await nummo.track({ customerId: "bob", featureId: "message", value: 250 });
    await tick();
    let bob = await nummo.customers.get("bob");
    let bobPro = bob.subscriptions.find((s) => s.planId === "pro")!;
    check(bobPro.status === "past_due", `bob: past_due, next retry ${bobPro.nextRetryAt}`);
    const blocked = await nummo.check({ customerId: "bob", featureId: "message" });
    check(blocked.allowed === false && blocked.overage?.allowed === false, "bob: overage blocked while past due");
    for (let i = 0; i < 12 && bobPro.status !== "ended"; i++) {
      const wait = Math.max(new Date(bobPro.nextRetryAt ?? Date.now()).getTime() - Date.now(), 0) + 1_000;
      log(`  waiting ${Math.round(wait / 1000)}s for the next retry`);
      await sleep(wait);
      await tick();
      bob = await nummo.customers.get("bob");
      bobPro = bob.subscriptions.find((s) => s.planId === "pro")!;
      log(`  bob: ${bobPro.status}${bobPro.nextRetryAt ? `, next retry ${bobPro.nextRetryAt}` : ""}`);
    }
    check(bobPro.status === "ended" && bobPro.endedReason === "payment_failed", "bob: ended after the last retry");
    check(bob.subscriptions.some((s) => s.planId === "free" && s.status === "active"), "bob: back on the free plan");
    check(bob.balances.find((b) => b.featureId === "credits")?.balance === "10", "bob: 10 free credits");
    v = await nummo.verify();
    check(v.ok, `verify: no drift after the failed payment (${v.differences.map((d) => d.kind).join(", ") || "no notices"})`);

    // ---- Cancellation signed by the customer, outside nummo
    log("cancellation: carol signs cancelSubscription in her wallet (the puller pays the fee)");
    const carolSub = (await nummo.customers.get("carol")).subscriptions.find((s) => s.planId === "pro")!;
    await sendAndConfirm(rpc, await loadKeypair(`${KEYS}/puller.json`), [
      await getCancelSubscriptionOverlayInstructionAsync({
        planPda: address(pro.published!.address),
        subscriber: signers.carol!,
        subscriptionPda: address(carolSub.subscriptionAddress!),
      }),
    ]);
    v = await nummo.verify();
    check(v.differences.some((d) => d.kind === "cancellation"), "verify: sees the on-chain cancellation before the reconciler runs");
    await reconcileTick(db, chains);
    const carol = (await nummo.customers.get("carol")).subscriptions.find((s) => s.planId === "pro")!;
    state.carolCancelAt = carol.cancelAt ?? undefined;
    save();
    check(carol.status === "canceling" && carol.cancelAt === carol.currentPeriodEnd, `carol: canceling, ends ${carol.cancelAt}`);
    v = await nummo.verify();
    check(v.ok, "verify: no drift after the reconciler picked up the cancellation");

    // ---- Webhooks
    log("webhooks: dispatch the outbox");
    for (let i = 0; i < 5; i++) await dispatchTick(db);
    const secret = (await nummo.webhooks.get()).endpoint!.secret;
    const valid = await Promise.all(hooks.map((h) => verifyWebhook(h.body, h.sig, secret)));
    const types = hooks.map((h) => JSON.parse(h.body).type as string);
    check(hooks.length > 0 && valid.every(Boolean), `${hooks.length} webhooks delivered, all signatures valid`);
    for (const t of ["subscription.activated", "payment.succeeded", "invoice.finalized", "payment.failed", "subscription.past_due", "subscription.ended", "subscription.canceled"]) {
      check(types.includes(t), `webhook ${t} delivered`);
    }

    log("nummo verify (CLI)");
    check((await cli(env, "verify")).code === 0, "CLI verify exits 0");

    const renewalAt = new Date(new Date(state.aliceAnchor!).getTime() + 3_600_000 + settings.boundaryMarginMs);
    log(`renewal is due at ${renewalAt.toISOString()}; then run: node e2e/devnet.ts renewal`);
  } finally {
    await shutdown();
  }
}

// ---------------------------------------------------------------- phase: renewal

async function renewal() {
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  const due = new Date(state.aliceAnchor!).getTime() + 3_600_000 + 50_000;
  if (Date.now() < due) {
    log(`waiting ${Math.round((due - Date.now()) / 1000)}s for the period boundary`);
    await sleep(due - Date.now());
  }
  const { db, chains, settings, apiUrl, chain, shutdown } = await harness(state);
  const nummo = new Nummo({ secretKey: state.apiKey, baseUrl: apiUrl, timeoutMs: 120_000 });
  const merchant = await loadKeypair(`${KEYS}/merchant.json`);
  try {
    const before = await tokenBalance(state.mint, merchant.address);
    log("renewal: one settlement pass after the boundary");
    const report = await settlementTick(db, chains, settings);
    log(`  ${JSON.stringify(report)}`);
    const alice = await nummo.customers.get("alice");
    const inv = alice.invoices.find((i) => i.kind === "renewal");
    check(inv?.status === "paid" && inv.total === "2", `alice: renewal invoice of 2 USDC paid (${inv?.payments[0]?.signature})`);
    check(alice.balances.find((b) => b.featureId === "credits")?.balance === "100", "alice: credits reset to 100 for the new period");
    const pro = alice.subscriptions.find((s) => s.planId === "pro")!;
    const onchain = (await chain.getSubscription(pro.subscriptionAddress!))!;
    check(onchain.currentPeriodStart.toISOString() === pro.currentPeriodStart, `on-chain period advanced to ${onchain.currentPeriodStart.toISOString()}, matching ours`);
    check(onchain.amountPulledInPeriod === 2n * U, "on-chain amountPulledInPeriod is 2 USDC");

    const carol = await nummo.customers.get("carol");
    const carolPro = carol.subscriptions.find((s) => s.planId === "pro")!;
    check(carolPro.status === "ended" && carolPro.endedReason === "canceled", "carol: ended at the period end, not renewed");
    check(carol.subscriptions.some((s) => s.planId === "free" && s.status === "active"), "carol: back on the free plan");
    check((await tokenBalance(state.mint, merchant.address)) - before === 2n * U, "merchant received exactly one renewal (alice's 2 USDC)");

    const v = await nummo.verify();
    check(v.ok, `verify: no drift after renewal (${v.differences.map((d) => d.kind).join(", ") || "no notices"})`);
    check((await cli({ NUMMO_SECRET_KEY: state.apiKey, NUMMO_API_URL: apiUrl }, "verify")).code === 0, "CLI verify exits 0");
  } finally {
    await shutdown();
  }
}

const phase = process.argv[2] ?? "run";
const started = Date.now();
if (phase === "run") await run();
else if (phase === "renewal") await renewal();
else {
  console.log("usage: node e2e/devnet.ts run|renewal");
  process.exit(2);
}
log(`${failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`} in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(failures === 0 ? 0 : 1);
