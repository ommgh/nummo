#!/usr/bin/env node
/**
 * The nummo CLI (doc 04, "CLI"). Run `nummo --help` for the commands.
 *
 * Reads NUMMO_SECRET_KEY and NUMMO_API_URL, or the key stored by `nummo login`.
 * Publishing signs with the merchant's wallet, which stays on this machine; the
 * server only checks the plan it created.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { address, createSolanaRpc } from "@solana/kit";
import { type ConfigInput, toDocument } from "@usenummo/config";
import { Nummo, NummoApiError } from "@usenummo/sdk";
import { loadKeypair, publishPlan, withRateLimitRetry } from "@usenummo/solana";
import { credentialsPath, readCredentials, removeCredentials, resolveAuth, writeCredentials } from "./credentials.ts";
import { addressOf, balances, newKeypairFile } from "./wallet.ts";
import { CONFIG_TEMPLATE } from "./template.ts";

const RPC = { devnet: "https://api.devnet.solana.com", mainnet: "https://api.mainnet-beta.solana.com" } as Record<string, string>;

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error("not a terminal: pass --yes to apply without asking");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function push(nummo: Nummo, configPath: string, yes: boolean) {
  const mod = (await import(pathToFileURL(resolve(configPath)).href)) as { default: ConfigInput };
  const doc = toDocument(mod.default);
  const dry = await nummo.config.push(doc, { dryRun: true });
  const changes = dry.changes.filter((c) => c.action !== "unchanged");
  if (changes.length === 0) return console.log("Nothing to change.");
  for (const c of changes) console.log(`  ${c.action.padEnd(8)} ${c.kind.replace("_", " ")} ${c.id}`);
  if (!(await confirm("Apply these changes?", yes))) return console.log("Nothing applied.");
  await nummo.config.push(doc);
  console.log("Applied.");
  const plans = await nummo.plans.list();
  const unpublished = plans.versions.filter((v) => v.paid && !v.published);
  if (unpublished.length) console.log(`\n${unpublished.length} paid plan version(s) need an on-chain plan: run \`nummo plans publish --keypair <merchant wallet>\`.`);
}

async function listPlans(nummo: Nummo) {
  const { settlement, versions } = await nummo.plans.list();
  console.log(settlement ? `Settling on ${settlement.network} in ${settlement.mint}; puller ${settlement.puller}\n` : "Settlement is not configured on the server.\n");
  for (const v of versions) {
    const terms = v.onchainTerms ? `ceiling ${v.onchainTerms.ceiling} USDC ${v.onchainTerms.period}` : "free";
    const state = !v.paid ? "" : v.published ? `published ${v.published.address}` : "NOT PUBLISHED";
    console.log(`  ${`${v.planId}@${v.version}`.padEnd(16)} ${v.name.padEnd(14)} ${terms.padEnd(36)} ${state}`);
  }
}

async function publish(nummo: Nummo, keypairPath: string, rpcUrl: string | undefined, yes: boolean) {
  const { settlement, versions } = await nummo.plans.list();
  if (!settlement) throw new Error("the server has no chain configured for this environment (NUMMO_TEST_PULLER_KEY)");
  const todo = versions.filter((v) => v.paid && !v.published);
  if (todo.length === 0) return console.log("Every paid plan version is published.");

  const merchant = await loadKeypair(keypairPath);
  const rpc = createSolanaRpc(rpcUrl ?? RPC[settlement.network] ?? RPC.devnet!);
  const mintInfo = await withRateLimitRetry(() => rpc.getAccountInfo(address(settlement.mint), { encoding: "base64" }).send());
  if (!mintInfo.value) throw new Error(`mint ${settlement.mint} does not exist on ${settlement.network}`);

  console.log(`Merchant wallet ${merchant.address} will own these plans and receive payments.`);
  console.log(`Puller ${settlement.puller} will be allowed to collect, only to the merchant wallet.\n`);
  for (const v of todo) {
    const t = v.onchainTerms!;
    console.log(`  ${v.planId}@${v.version}: up to ${t.ceiling} USDC ${t.period} (base ${v.base})`);
  }
  if (!(await confirm(`\nCreate ${todo.length} on-chain plan(s)? Amount and period cannot change afterwards.`, yes))) return;

  for (const v of todo) {
    const t = v.onchainTerms!;
    const r = await publishPlan(rpc, {
      merchant,
      planId: BigInt(t.planId),
      mint: settlement.mint,
      tokenProgram: mintInfo.value.owner,
      amount: BigInt(t.amount),
      periodHours: t.periodHours,
      puller: settlement.puller,
      metadataUri: t.metadataUri,
    });
    await nummo.plans.publish(v.planId, v.version, r.planAddress);
    console.log(`  ${v.planId}@${v.version} published at ${r.planAddress}${r.signature ? ` (${r.signature})` : " (already existed)"}`);
  }
}

async function verifyCmd(nummo: Nummo) {
  const r = await nummo.verify();
  console.log(`Checked ${r.plans} plan version(s) and ${r.subscriptions} live subscription(s) on ${r.network}.`);
  for (const d of r.differences) console.log(`  ${d.severity === "drift" ? "DRIFT " : "notice"} ${d.kind.padEnd(20)} ${d.subject}: ${d.message}`);
  console.log(r.ok ? "No drift." : "Drift found.");
  if (!r.ok) process.exitCode = 1;
}

const HELP = `usage: nummo <command>

Getting started
  nummo init [--config nummo.config.ts]       write a starter pricing config
  nummo login --key <secret key> [--api <url>] store a key for the other commands
  nummo logout
  nummo whoami                                 which API and environment the key reaches
  nummo wallet new <file> [--force]            create a keypair file (Solana CLI format)
  nummo wallet balance <file|address> [--network devnet|mainnet]

Pricing and plans
  nummo push [--config nummo.config.ts] [--yes]
  nummo plans
  nummo plans publish --keypair <merchant.json> [--rpc <url>] [--yes]

Customers
  nummo customers list [--search <text>]
  nummo customers get <id>
  nummo preview <customer> <plan>              what attaching a plan would cost now
  nummo attach <customer> <plan>               attach, printing a checkout link for paid plans
  nummo portal <customer>                      a link to the customer's billing portal

Operations
  nummo verify                                 compare our records with the chain; exits 1 on drift
  nummo dashboard                              the dashboard's address

env: NUMMO_SECRET_KEY and NUMMO_API_URL (default http://localhost:8787) override \`nummo login\`.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "nummo.config.ts" },
      keypair: { type: "string" },
      rpc: { type: "string" },
      key: { type: "string" },
      api: { type: "string" },
      search: { type: "string" },
      network: { type: "string", default: "devnet" },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, arg] = positionals;
  if (values.help || !cmd) return console.log(HELP);

  // Commands that need no API key.
  if (cmd === "init") {
    const path = resolve(values.config!);
    if (existsSync(path) && !values.force) throw new Error(`${values.config} exists; pass --force to overwrite it`);
    writeFileSync(path, CONFIG_TEMPLATE);
    return console.log(`Wrote ${values.config}. Edit it, then run \`nummo push\`.`);
  }
  if (cmd === "wallet" && sub === "new" && arg) {
    const addr = newKeypairFile(arg, values.force);
    console.log(`${arg}: ${addr}\nKeep this file private. Devnet SOL: https://faucet.solana.com  Devnet USDC: https://faucet.circle.com`);
    return;
  }
  if (cmd === "wallet" && sub === "balance" && arg) {
    const owner = await addressOf(arg);
    const network = values.network === "mainnet" ? "mainnet" : "devnet";
    const b = await balances(owner, network, values.rpc);
    console.log(`${owner} on ${network}: ${b.sol} SOL, ${b.usdc === null ? "no USDC account" : `${b.usdc} USDC`}`);
    return;
  }
  if (cmd === "logout") return console.log(removeCredentials() ? "Logged out." : "Not logged in.");
  if (cmd === "login") {
    const secretKey = values.key ?? process.env.NUMMO_SECRET_KEY;
    if (!secretKey) throw new Error("pass --key nummo_sk_test_... (or set NUMMO_SECRET_KEY)");
    const apiUrl = (values.api ?? process.env.NUMMO_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
    const plans = await new Nummo({ secretKey, baseUrl: apiUrl }).plans.list();
    writeCredentials({ apiUrl, secretKey });
    const env = secretKey.startsWith("nummo_sk_live_") ? "live" : "test";
    console.log(`Logged in to ${apiUrl} (${env}${plans.settlement ? `, settling on ${plans.settlement.network}` : ", settlement off"}). Saved to ${credentialsPath()}.`);
    return;
  }

  const auth = resolveAuth();
  if (!auth.secretKey) throw new Error("no API key: run `nummo login --key <secret key>` or set NUMMO_SECRET_KEY");
  const nummo = new Nummo(auth);
  const apiUrl = (auth.baseUrl ?? "http://localhost:8787").replace(/\/$/, "");
  if (cmd === "push") return push(nummo, values.config!, values.yes!);
  if (cmd === "plans" && !sub) return listPlans(nummo);
  if (cmd === "plans" && sub === "publish") {
    if (!values.keypair) throw new Error("pass --keypair <path to the merchant wallet's keypair file>");
    return publish(nummo, values.keypair, values.rpc, values.yes!);
  }
  if (cmd === "verify") return verifyCmd(nummo);
  if (cmd === "customers" && sub === "get" && arg) return console.log(JSON.stringify(await nummo.customers.get(arg), null, 2));
  if (cmd === "customers" && (sub === "list" || !sub)) {
    const r = await nummo.customers.list({ search: values.search, limit: 100 });
    for (const c of r.customers) {
      console.log(`  ${c.id.padEnd(24)} ${(c.name ?? "").padEnd(18)} ${c.plans.map((p) => `${p.planId}@${p.version}${p.status === "active" ? "" : ` (${p.status})`}`).join(", ")}`);
    }
    return console.log(`${r.customers.length} of ${r.total}`);
  }
  if (cmd === "preview" && sub && arg) {
    const p = await nummo.preview({ customerId: sub, planId: arg });
    if (p.change === "blocked") return console.log(`Blocked: ${p.reason}`);
    if (p.change === "none") return console.log(`${sub} is already on ${arg}.`);
    const when = p.change === "downgrade" ? `at ${p.effectiveAt}` : "now";
    return console.log(`${p.change}: ${p.from ? `${p.from.planId}@${p.from.version} -> ` : ""}${p.plan.planId}@${p.plan.version} ${when}; due now ${p.dueNow} USDC${p.credit !== "0" ? ` after a ${p.credit} USDC credit` : ""}${p.signatureRequired ? "; the customer signs with their wallet" : ""}.`);
  }
  if (cmd === "attach" && sub && arg) {
    const r = await nummo.attach({ customerId: sub, planId: arg });
    if (r.checkoutUrl) return console.log(`Pending: send the customer to ${r.checkoutUrl}`);
    if (r.status === "scheduled") return console.log(`Scheduled for ${r.effectiveAt}.`);
    return console.log(r.alreadyAttached ? `${sub} is already on ${arg}.` : `${sub} is now on ${arg}.`);
  }
  if (cmd === "portal" && sub) return console.log((await nummo.portal({ customerId: sub })).url);
  if (cmd === "dashboard") return console.log(`${apiUrl}/dashboard  (sign in with your secret key)`);
  if (cmd === "whoami") {
    const plans = await nummo.plans.list();
    const stored = readCredentials();
    const env = auth.secretKey.startsWith("nummo_sk_live_") ? "live" : "test";
    return console.log(`${apiUrl}, ${env} environment, ${plans.settlement ? `settling on ${plans.settlement.network} (puller ${plans.settlement.puller})` : "settlement off"}${process.env.NUMMO_SECRET_KEY ? "; key from NUMMO_SECRET_KEY" : stored ? "; key from nummo login" : ""}`);
  }
  throw new Error(`unknown command: ${positionals.join(" ")}`);
}

main().catch((e) => {
  console.error(e instanceof NummoApiError ? `error (${e.code}): ${e.message}` : `error: ${(e as Error).message}`);
  process.exit(1);
});
