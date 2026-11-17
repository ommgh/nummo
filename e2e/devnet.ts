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

import { HERE, ROOT, KEYS, STATE_FILE, RPC_URL, U, rpc, DATABASE_URL, type Customer, type State, result, log, check, fmt, sleep, newKey, sol, tokenBalance, createMint, mintTo, computeUnits, cli, harness, checkoutAs } from "./lib.ts";

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
      c.subscriptionId = a.subscriptionId!;
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
log(`${result.failures === 0 ? "all checks passed" : `${result.failures} check(s) FAILED`} in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(result.failures === 0 ? 0 : 1);
