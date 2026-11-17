// Milestone M3 scenarios on Solana devnet (doc 05).
//
//   node e2e/devnet-m3.ts
//
// - publish a plan from the dashboard with the merchant's wallet (as the browser does), the rest with the CLI
// - upgrade Pro -> Team mid-period: one signature subscribes, pays the prorated difference and cancels Pro
// - overage used on Pro before the change is still collected from Pro afterwards
// - a scheduled downgrade, and cancelling it
// - a one-off top-up paid by a plain transfer carrying a reference key
// - an automatic top-up pulled from the subscription when credits run low
// - cancel and resume from the customer portal, signed by the customer's wallet
// - `nummo verify` reports no drift after each step
//
// Same harness as e2e/devnet.ts: real API in-process, real CLI, a 6-decimal test
// mint the merchant controls, customer wallets with USDC and no SOL.

import { mkdirSync } from "node:fs";
import {
  type KeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  signature as toSignature,
} from "@solana/kit";
import { createApiKey, createOrg } from "@usenummo/db";
import { Nummo } from "@usenummo/sdk";
import { settlementTick } from "@usenummo/settlement";
import { loadKeypair } from "@usenummo/solana";
import { check, checkoutAs, cli, createMint, harness, KEYS, log, mintTo, newKey, result, rpc, sleep, sol, tokenBalance, U } from "./lib.ts";

/** What a browser wallet does: sign the bytes it was given, without broadcasting. */
async function signAs(transaction: string, signer: KeyPairSigner) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  return getBase64EncodedWireTransaction(await partiallySignTransaction([signer.keyPair], tx as Parameters<typeof partiallySignTransaction>[1]));
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok) throw new Error(`${new URL(url).pathname}: ${j.error?.message ?? r.status}`);
  return j;
}

const started = Date.now();
const merchant = await loadKeypair(`${KEYS}/merchant.json`).catch(() => loadKeypair(new URL("../spikes/.keys/merchant.json", import.meta.url).pathname));
const pullerKey = await loadKeypair(`${KEYS}/puller.json`).catch(() => loadKeypair(new URL("../spikes/.keys/puller.json", import.meta.url).pathname));
const merchantSolBefore = await sol(merchant.address);
const pullerSolBefore = await sol(pullerKey.address);
log(`merchant ${merchant.address} (${Number(merchantSolBefore) / 1e9} SOL)`);
log(`puller   ${pullerKey.address} (${Number(pullerSolBefore) / 1e9} SOL)`);
if (pullerSolBefore < 20_000_000n) throw new Error("the puller needs at least 0.02 devnet SOL");

log("creating a 6-decimal test mint and three customer wallets with no SOL");
const mint = await createMint(merchant);
const runDir = `${KEYS}/m3-${Date.now()}`;
mkdirSync(runDir, { recursive: true });
const signers: Record<string, KeyPairSigner> = {};
for (const [name, amount] of Object.entries({ dave: 30n * U, erin: 10n * U, frank: 10n * U })) {
  signers[name] = await newKey(`${runDir}/${name}.json`);
  await mintTo(merchant, mint, signers[name].address, amount);
  log(`  ${name.padEnd(5)} ${signers[name].address} holds ${Number(amount) / 1e6} USDC`);
}

const { db, chains, chain, settings, apiUrl, shutdown } = await harness({ mint });
const orgId = await createOrg(db, `e2e M3 ${new Date().toISOString()}`);
const { key: apiKey } = await createApiKey(db, orgId, "test");
const env = { NUMMO_SECRET_KEY: apiKey, NUMMO_API_URL: apiUrl };
const nummo = new Nummo({ secretKey: apiKey, baseUrl: apiUrl, timeoutMs: 120_000 });
const tick = () => settlementTick(db, chains, settings);
const verifyOk = async (what: string) => {
  const v = await nummo.verify();
  check(v.ok, `verify: no drift ${what}${v.differences.length ? ` (notices: ${v.differences.map((d) => d.kind).join(", ")})` : ""}`);
};
const creditsOf = async (c: string) => (await nummo.customers.get(c)).balances.find((b) => b.featureId === "credits")?.balance;

try {
  check((await cli(env, "push", "--config", "e2e/m3.config.ts", "--yes")).code === 0, "config pushed with the CLI");

  // ---- Publishing from the dashboard with the merchant's wallet
  log("dashboard: sign in with the key and publish pro@1 with the merchant wallet");
  const login = await fetch(`${apiUrl}/dashboard/login`, { method: "POST", body: new URLSearchParams({ key: apiKey }), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const built = await post(`${apiUrl}/dashboard/plans/pro/1/transaction`, { owner: merchant.address }, { cookie });
  const published = await post(
    `${apiUrl}/dashboard/plans/pro/1/submit`,
    { owner: merchant.address, signedTransaction: await signAs(built.transaction, merchant), message: built.message, lastValidBlockHeight: built.lastValidBlockHeight, planAddress: built.planAddress },
    { cookie },
  );
  check(published.address === built.planAddress, `pro@1 created by the wallet-signed transaction and registered (${published.signature})`);
  check((await cli(env, "plans", "publish", "--keypair", `${KEYS}/merchant.json`, "--yes")).code === 0, "team@1 and refill@1 published with the CLI");
  const plans = await nummo.plans.list();
  check(plans.versions.filter((v) => v.paid).every((v) => v.published), "every paid plan version is published");

  // ---- Upgrade with proration
  log("dave: subscribes to Pro, uses 150 credits (50 over), then upgrades to Team");
  const sub = await nummo.attach({ customerId: "dave", planId: "pro" });
  const first = await checkoutAs(apiUrl, sub.checkoutUrl!, signers.dave!);
  check(first.done.status === "completed", `dave: Pro activated (${first.done.signature})`);
  const proSubId = sub.subscriptionId!;
  await nummo.track({ customerId: "dave", featureId: "message", value: 150 });
  await sleep(5_000);

  const preview = await nummo.preview({ customerId: "dave", planId: "team" });
  check(preview.change === "upgrade" && Number(preview.credit) > 1.9 && Number(preview.dueNow) < 3.1, `preview: upgrade now, ${preview.credit} USDC credit, ${preview.dueNow} USDC due`);
  const merchantBefore = await tokenBalance(mint, merchant.address);
  const up = await nummo.attach({ customerId: "dave", planId: "team" });
  check(up.status === "pending" && up.checkoutUrl !== null, "attach team returns a checkout for the change");
  const change = await checkoutAs(apiUrl, up.checkoutUrl!, signers.dave!);
  check(change.done.status === "completed" && change.done.kind === "change", `dave: one signature switched Pro to Team (${change.done.signature})`);
  const paid = (await tokenBalance(mint, merchant.address)) - merchantBefore;
  check(paid > 2n * U && paid < 4n * U, `merchant received the prorated ${Number(paid) / 1e6} USDC, not the full 5`);
  const dave = await nummo.customers.get("dave");
  const oldPro = dave.subscriptions.find((s) => s.id === proSubId)!;
  const team = dave.subscriptions.find((s) => s.planId === "team")!;
  check(team.status === "active", "dave: Team active");
  check(oldPro.status === "canceling" && oldPro.replacedBy === team.id, "dave: Pro replaced, winding down");
  const oldOnchain = await chain.getSubscription(oldPro.subscriptionAddress!);
  check(oldOnchain?.expiresAt?.toISOString() === oldPro.cancelAt, `Pro cancelled on-chain in the same transaction, ends ${oldOnchain?.expiresAt?.toISOString()}`);
  check((await creditsOf("dave")) === "500", "dave: 500 Team credits; Pro grants no more");
  const activation = dave.invoices.find((i) => i.subscriptionId === team.id && i.kind === "activation")!;
  check(activation.lines.some((l) => l.kind === "proration" && l.amount.startsWith("-")), `Team invoice: base 5 less a ${activation.lines.find((l) => l.kind === "proration")?.amount.slice(1)} USDC credit`);
  await verifyOk("after the upgrade");

  log("settlement pass: Pro's 0.50 USDC of overage is collected from Pro");
  await tick();
  const after = await nummo.customers.get("dave");
  const overageInv = after.invoices.find((i) => i.subscriptionId === proSubId && i.kind === "overage");
  check(overageInv?.status === "paid" && overageInv.total === "0.5", `Pro overage invoice paid (${overageInv?.payments[0]?.signature})`);
  await verifyOk("after collecting the old plan's overage");

  // ---- Downgrade scheduled, then kept
  const down = await nummo.attach({ customerId: "dave", planId: "pro" });
  check(down.status === "scheduled", `Team -> Pro is scheduled for ${down.effectiveAt}`);
  const keep = await nummo.attach({ customerId: "dave", planId: "team" });
  check(keep.alreadyAttached && (await nummo.customers.get("dave")).subscriptions.find((s) => s.id === team.id)!.scheduledChange === null, "attaching Team again cancels the scheduled downgrade");

  // ---- One-off top-up
  log("erin: buys 300 credits for 3 USDC");
  const t = await nummo.topUp({ customerId: "erin", featureId: "credits", amount: 3n * U });
  const before = await tokenBalance(mint, merchant.address);
  const top = await checkoutAs(apiUrl, t.checkoutUrl, signers.erin!);
  check(top.done.status === "completed" && top.done.kind === "topup", `erin: top-up paid (${top.done.signature})`);
  check((await tokenBalance(mint, merchant.address)) - before === 3n * U, "merchant received 3 USDC by plain transfer");
  check((await creditsOf("erin")) === "310", "erin: 10 free + 300 purchased credits");
  const reference = top.session.topup.reference as string;
  const tx = await rpc.getTransaction(toSignature(top.done.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }).send();
  check((tx?.transaction.message.accountKeys as string[] | undefined)?.includes(reference) === true, `the transfer carries the reference key ${reference}`);
  check((await sol(signers.erin!.address)) === 0n, "erin: held and spent no SOL");

  // ---- Automatic top-up
  log("frank: on Refill, uses 7 of 10 credits; the refill is pulled from the subscription");
  const r = await nummo.attach({ customerId: "frank", planId: "refill" });
  check((await checkoutAs(apiUrl, r.checkoutUrl!, signers.frank!)).done.status === "completed", "frank: Refill activated");
  await nummo.track({ customerId: "frank", featureId: "message", value: 7 });
  check((await creditsOf("frank")) === "3", "frank: 3 credits left, below the threshold of 5; nothing granted before payment");
  await tick();
  const frank = await nummo.customers.get("frank");
  const refill = frank.invoices.find((i) => i.kind === "topup");
  check(refill?.status === "paid" && refill.total === "1", `automatic top-up of 1 USDC pulled (${refill?.payments[0]?.signature})`);
  check((await creditsOf("frank")) === "103", "frank: 100 credits added once the pull confirmed");
  await verifyOk("after the automatic top-up");

  // ---- Portal: cancel and resume, signed by the customer's wallet
  log("dave: cancels Team from the portal, then resumes it");
  const { url } = await nummo.portal({ customerId: "dave", returnUrl: "https://merchant.example/account" });
  const portal = new URL(url).pathname;
  const data = await (await fetch(`${apiUrl}${portal}/data`)).json();
  check(data.plans.some((p: { planId: string; current: boolean }) => p.planId === "team" && p.current), "portal shows Team as the current plan");
  for (const action of ["cancel", "resume"] as const) {
    const { transaction } = await post(`${apiUrl}${portal}/transaction`, { action, subscriptionId: team.id, wallet: signers.dave!.address });
    const res = await post(`${apiUrl}${portal}/submit`, { signedTransaction: await signAs(transaction, signers.dave!) });
    const s = (await nummo.customers.get("dave")).subscriptions.find((x) => x.id === team.id)!;
    const ok = action === "cancel" ? s.status === "canceling" && s.cancelAt !== null : s.status === "active" && s.cancelAt === null;
    check(res.confirmed && ok, `portal ${action}: ${s.status}${s.cancelAt ? ` until ${s.cancelAt}` : ""} (${res.signature})`);
    await verifyOk(`after the portal ${action}`);
  }
  check((await sol(signers.dave!.address)) === 0n, "dave: held and spent no SOL throughout");

  check((await cli(env, "verify")).code === 0, "CLI verify exits 0");
  log(`puller spent ${Number(pullerSolBefore - (await sol(pullerKey.address))) / 1e9} SOL; merchant spent ${Number(merchantSolBefore - (await sol(merchant.address))) / 1e9} SOL (mint, plans, minting)`);
} catch (e) {
  check(false, `stopped: ${(e as Error).message}`);
} finally {
  await shutdown();
}
log(`${result.failures === 0 ? "all checks passed" : `${result.failures} check(s) FAILED`} in ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(result.failures === 0 ? 0 : 1);
