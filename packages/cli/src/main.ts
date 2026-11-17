#!/usr/bin/env node
/**
 * The nummo CLI (doc 04, "CLI").
 *
 *   nummo push [--config nummo.config.ts] [--yes]
 *   nummo plans
 *   nummo plans publish --keypair <merchant.json> [--rpc <url>] [--yes]
 *   nummo verify
 *   nummo customers get <id>
 *
 * Reads NUMMO_SECRET_KEY and NUMMO_API_URL. Publishing signs with the
 * merchant's wallet, which stays on this machine; the server only checks the
 * plan it created.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { address, createSolanaRpc } from "@solana/kit";
import { type ConfigInput, toDocument } from "@usenummo/config";
import { Nummo, NummoApiError } from "@usenummo/sdk";
import { loadKeypair, publishPlan, withRateLimitRetry } from "@usenummo/solana";

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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: "nummo.config.ts" },
      keypair: { type: "string" },
      rpc: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, arg] = positionals;
  if (values.help || !cmd) {
    console.log(`usage:
  nummo push [--config nummo.config.ts] [--yes]
  nummo plans
  nummo plans publish --keypair <merchant.json> [--rpc <url>] [--yes]
  nummo verify
  nummo customers get <id>

env: NUMMO_SECRET_KEY, NUMMO_API_URL (default http://localhost:8787)`);
    return;
  }
  const nummo = new Nummo();
  if (cmd === "push") return push(nummo, values.config!, values.yes!);
  if (cmd === "plans" && !sub) return listPlans(nummo);
  if (cmd === "plans" && sub === "publish") {
    if (!values.keypair) throw new Error("pass --keypair <path to the merchant wallet's keypair file>");
    return publish(nummo, values.keypair, values.rpc, values.yes!);
  }
  if (cmd === "verify") return verifyCmd(nummo);
  if (cmd === "customers" && sub === "get" && arg) return console.log(JSON.stringify(await nummo.customers.get(arg), null, 2));
  throw new Error(`unknown command: ${positionals.join(" ")}`);
}

main().catch((e) => {
  console.error(e instanceof NummoApiError ? `error (${e.code}): ${e.message}` : `error: ${(e as Error).message}`);
  process.exit(1);
});
