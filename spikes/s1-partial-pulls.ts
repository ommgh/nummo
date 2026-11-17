// Spike S1 (+ most of S2), see docs/05-roadmap-and-grant.md.
//
// S1: can a puller make several partial pulls in one period, up to the plan amount?
// S2: does a one-signature activation (init authority + subscribe + first pull) work
//     with the puller as fee payer and rent payer?
//
// Runs on devnet with a throwaway 6-decimal mint we create ourselves (the program is
// mint-agnostic, so this answers the same question as devnet USDC without a faucet).
//
//   node s1-partial-pulls.ts setup      fund wallets, create mint, plan, activate, pull
//   node s1-partial-pulls.ts pulls      resume the partial pulls on the plan setup created
//   node s1-partial-pulls.ts rollover   run after the 1-hour period ends: pull again
//
// Keys live in ./.keys (gitignored). State between phases lives in ./s1.state.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createClient,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { solanaDevnetRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  tokenProgram,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  UNKNOWN_INIT_ID,
  fetchPlan,
  fetchSubscriptionDelegation,
  findPlanPda,
  findSubscriptionDelegationPda,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getSubscribeOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
  subscriptionsProgram,
} from "@solana/subscriptions";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const UNIT = 1_000_000n; // 6 decimals, like USDC
const PLAN_AMOUNT = 70n * UNIT; // 20 base + 50 overage cap (decision D3)
const PERIOD_HOURS = 1n;
const STATE_FILE = "s1.state.json";

type State = {
  mint: Address;
  planId: string;
  planPda: Address;
  subscriptionPda: Address;
  merchantAta: Address;
  subscriberAta: Address;
};

// ---------- helpers ----------

async function loadKey(name: string): Promise<KeyPairSigner> {
  mkdirSync(".keys", { recursive: true });
  const path = `.keys/${name}.json`;
  if (existsSync(path)) {
    return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
  }
  // Generate an extractable keypair so we can persist it.
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const bytes = new Uint8Array([...pkcs8.slice(-32), ...pub]);
  writeFileSync(path, JSON.stringify([...bytes]));
  return createKeyPairSignerFromBytes(bytes);
}

function clientFor(identity: KeyPairSigner) {
  return createClient()
    .use(signer(identity))
    .use(solanaDevnetRpc({ rpcUrl: RPC_URL }))
    .use(tokenProgram())
    .use(subscriptionsProgram());
}

/** Find a Subscriptions custom error code anywhere in an error chain. */
function programErrorCode(err: unknown): number | undefined {
  const seen = new Set<unknown>();
  const walk = (e: any): number | undefined => {
    if (!e || typeof e !== "object" || seen.has(e)) return;
    seen.add(e);
    if (typeof e.context?.code === "number") return e.context.code;
    if (e.Custom !== undefined) return Number(e.Custom);
    for (const v of Object.values(e)) {
      const r = walk(v);
      if (r !== undefined) return r;
    }
    return walk(e.cause);
  };
  return walk(err);
}

/** Devnet's public RPC rate-limits (HTTP 429). Retry those with backoff; never retry program errors. */
async function rl<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const is429 = e?.context?.statusCode === 429 || /\(429\)/.test(String(e?.message));
      if (!is429 || attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** Math.min(attempt, 4)));
    }
  }
}

async function sendTx(
  client: ReturnType<typeof clientFor>,
  feePayer: KeyPairSigner,
  ixs: Instruction[],
): Promise<string> {
  const { value: bh } = await rl(() => client.rpc.getLatestBlockhash({ commitment: "confirmed" }).send());
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const sig = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  console.log(`    tx size: ${Buffer.from(wire, "base64").length} bytes`);
  await rl(() => client.rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send());
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { value } = await rl(() => client.rpc.getSignatureStatuses([sig]).send());
    const s = value[0];
    if (s?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`tx ${sig} not confirmed in 60s`);
}

async function solBalance(client: ReturnType<typeof clientFor>, a: Address) {
  return (await rl(() => client.rpc.getBalance(a, { commitment: "confirmed" }).send())).value;
}

async function tokenBalance(client: ReturnType<typeof clientFor>, ata: Address) {
  return BigInt((await rl(() => client.rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send())).value.amount);
}

async function showSub(client: ReturnType<typeof clientFor>, pda: Address, label: string) {
  const s = (await rl(() => fetchSubscriptionDelegation(client.rpc, pda, { commitment: "confirmed" }))).data;
  console.log(
    `    [${label}] amountPulledInPeriod=${Number(s.amountPulledInPeriod) / 1e6} ` +
      `currentPeriodStartTs=${s.currentPeriodStartTs} expiresAtTs=${s.expiresAtTs} payer=${s.header.payer}`,
  );
  return s;
}

/** Pull `amount`; return "ok" or the program error code. */
async function pull(
  client: ReturnType<typeof clientFor>,
  puller: KeyPairSigner,
  subscriber: Address,
  st: State,
  amount: bigint,
): Promise<"ok" | number | string> {
  const ix = await rl(() => getTransferSubscriptionOverlayInstructionAsync({
    caller: puller,
    delegator: subscriber,
    planPda: st.planPda,
    subscriptionPda: st.subscriptionPda,
    receiverAta: st.merchantAta,
    tokenMint: st.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    amount,
  }));
  try {
    const sig = await sendTx(client, puller, [ix]);
    console.log(`    pull ${Number(amount) / 1e6}: ok  ${sig}`);
    return "ok";
  } catch (e) {
    const code = programErrorCode(e);
    console.log(`    pull ${Number(amount) / 1e6}: rejected, program error ${code ?? (e as Error).message}`);
    return code ?? (e as Error).message;
  }
}

function check(cond: boolean, what: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) process.exitCode = 1;
}

// ---------- phases ----------

async function setup() {
  const merchant = await loadKey("merchant"); // owns plan, receives funds
  const puller = await loadKey("puller"); // hot wallet: signs pulls, pays fees and rent
  const subscriber = await loadKey("subscriber"); // the customer; holds tokens, no SOL
  const mc = clientFor(merchant);

  console.log(`merchant   ${merchant.address}`);
  console.log(`puller     ${puller.address}`);
  console.log(`subscriber ${subscriber.address}`);

  // 1. SOL. Only the merchant needs funding from outside; it then funds the puller.
  let bal = await solBalance(mc, merchant.address);
  if (bal < 300_000_000n) {
    console.log("requesting devnet airdrop of 1 SOL to merchant...");
    try {
      await mc.rpc.requestAirdrop(merchant.address, lamports(1_000_000_000n)).send();
      for (let i = 0; i < 30 && (bal = await solBalance(mc, merchant.address)) < 300_000_000n; i++) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      console.log(`airdrop failed: ${(e as Error).message}`);
    }
  }
  if (bal < 300_000_000n) {
    console.log(`\nNot enough devnet SOL. Fund ${merchant.address} with ~1 SOL at https://faucet.solana.com and rerun.`);
    process.exit(2);
  }
  console.log(`merchant SOL: ${Number(bal) / 1e9}`);

  if ((await solBalance(mc, puller.address)) < 100_000_000n) {
    await sendTx(mc, merchant, [
      getTransferSolInstruction({ source: merchant, destination: puller.address, amount: 150_000_000n }),
    ]);
  }

  // 2. A 6-decimal test mint; merchant is mint authority. 200 tokens to the subscriber.
  const mintKp = await generateKeyPairSigner();
  await mc.token.instructions
    .createMint({ newMint: mintKp, decimals: 6, mintAuthority: merchant.address })
    .sendTransaction();
  const mint = mintKp.address;
  console.log(`mint       ${mint}`);
  await mc.token.instructions
    .mintToATA({ mint, owner: subscriber.address, mintAuthority: merchant, amount: 200n * UNIT, decimals: 6 })
    .sendTransaction();
  const [subscriberAta] = await findAssociatedTokenPda({ mint, owner: subscriber.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [merchantAta] = await findAssociatedTokenPda({ mint, owner: merchant.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await sendTx(mc, merchant, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: merchant, owner: merchant.address, mint }),
  ]);

  // 3. Plan: 70 per 1 hour, puller listed, destination locked to the merchant.
  const planId = BigInt(Date.now());
  await mc.subscriptions.instructions
    .createPlan({
      owner: merchant,
      planId,
      mint,
      amount: PLAN_AMOUNT,
      periodHours: PERIOD_HOURS,
      endTs: 0n,
      destinations: [merchant.address],
      pullers: [puller.address],
      metadataUri: "https://example.com/bill-spike-s1.json",
    })
    .sendTransaction();
  const [planPda] = await findPlanPda({ owner: merchant.address, planId });
  const [subscriptionPda] = await findSubscriptionDelegationPda({ planPda, subscriber: subscriber.address });
  console.log(`plan       ${planPda} (id ${planId})`);

  const st: State = { mint, planId: planId.toString(), planPda, subscriptionPda, merchantAta, subscriberAta };
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));

  // 4. S2: one-signature activation. Subscriber signs; puller is fee payer and rent payer.
  console.log("\nS2: activation in one transaction (init authority + subscribe + pull 20)");
  const pullerSolBefore = await solBalance(mc, puller.address);
  const subscriberSolBefore = await solBalance(mc, subscriber.address);
  const pc = clientFor(puller);
  const ixs = [
    await getInitSubscriptionAuthorityOverlayInstructionAsync({
      owner: subscriber,
      payer: puller,
      tokenMint: mint,
      userAta: subscriberAta,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    await getSubscribeOverlayInstructionAsync({
      subscriber,
      payer: puller,
      merchant: merchant.address,
      planId,
      tokenMint: mint,
      expectedAmount: PLAN_AMOUNT,
      expectedPeriodHours: PERIOD_HOURS,
      expectedCreatedAt: (await fetchPlan(pc.rpc, planPda, { commitment: "confirmed" })).data.data.terms.createdAt,
      expectedSubscriptionAuthorityInitId: UNKNOWN_INIT_ID,
    }),
    await getTransferSubscriptionOverlayInstructionAsync({
      caller: puller,
      delegator: subscriber.address,
      planPda,
      subscriptionPda,
      receiverAta: merchantAta,
      tokenMint: mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount: 20n * UNIT,
    }),
  ];
  let activated = false;
  try {
    const sig = await sendTx(pc, puller, ixs);
    activated = true;
    console.log(`    activation ok ${sig}`);
  } catch (e) {
    console.log(`    activation FAILED: ${(e as Error).message} (code ${programErrorCode(e)})`);
  }
  check(activated, "S2 one-transaction activation lands");
  if (!activated) return;
  const pullerSolAfter = await solBalance(mc, puller.address);
  const subscriberSolAfter = await solBalance(mc, subscriber.address);
  console.log(`    puller paid ${Number(pullerSolBefore - pullerSolAfter) / 1e9} SOL (fees + rent for 2 accounts)`);
  check(subscriberSolBefore === 0n && subscriberSolAfter === 0n, "S2 subscriber holds and spends no SOL");
  const s0 = await showSub(pc, subscriptionPda, "after activation");
  check(s0.header.payer === puller.address, "S2 subscription rent payer is the puller");
  check(s0.amountPulledInPeriod === 20n * UNIT, "S1 first pull of 20 counted");

  // 5. S1: partial pulls within the period.
  await runPulls(pc, puller, subscriber.address, st);
}

async function runPulls(pc: ReturnType<typeof clientFor>, puller: KeyPairSigner, subscriber: Address, st: State) {
  console.log("\nS1: partial pulls in one period (ceiling 70; 20 pulled at activation)");
  const s0 = await showSub(pc, st.subscriptionPda, "before pulls");
  if (s0.amountPulledInPeriod !== 20n * UNIT) {
    console.log("Expected exactly 20 pulled so far in this period; run setup again for a fresh plan.");
    process.exit(2);
  }
  check((await pull(pc, puller, subscriber, st, 5n * UNIT)) === "ok", "S1 pull 5 (total 25)");
  check((await pull(pc, puller, subscriber, st, 5n * UNIT)) === "ok", "S1 pull 5 (total 30)");
  check((await pull(pc, puller, subscriber, st, 50n * UNIT)) === 400, "S1 pull 50 rejected (would be 80 > 70), error 400 AmountExceedsPeriodLimit");
  check((await pull(pc, puller, subscriber, st, 40n * UNIT)) === "ok", "S1 pull 40 reaches the ceiling exactly (total 70)");
  check((await pull(pc, puller, subscriber, st, 1n)) === 400, "S1 pull of 1 base unit past the ceiling rejected");
  const s1 = await showSub(pc, st.subscriptionPda, "after pulls");
  check(s1.amountPulledInPeriod === PLAN_AMOUNT, "S1 amountPulledInPeriod == 70");
  check((await tokenBalance(pc, st.merchantAta)) === PLAN_AMOUNT, "S1 merchant received exactly 70");
  check((await tokenBalance(pc, st.subscriberAta)) === 130n * UNIT, "S1 subscriber has 130 left");

  const nextPeriod = Number(s1.currentPeriodStartTs) + Number(PERIOD_HOURS) * 3600;
  console.log(`\nNext period starts at ${new Date(nextPeriod * 1000).toISOString()}. Then run: node s1-partial-pulls.ts rollover`);
}

async function pulls() {
  const st: State = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const puller = await loadKey("puller");
  const subscriber = await loadKey("subscriber");
  await runPulls(clientFor(puller), puller, subscriber.address, st);
}

async function rollover() {
  const st: State = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const puller = await loadKey("puller");
  const subscriber = await loadKey("subscriber");
  const pc = clientFor(puller);
  const before = await showSub(pc, st.subscriptionPda, "before rollover");
  const now = Math.floor(Date.now() / 1000);
  const boundary = Number(before.currentPeriodStartTs) + Number(PERIOD_HOURS) * 3600;
  if (now < boundary) {
    console.log(`Period not over yet; wait ${boundary - now}s.`);
    process.exit(2);
  }
  console.log("\nS1: next period");
  check((await pull(pc, puller, subscriber.address, st, 20n * UNIT)) === "ok", "S1 pull 20 in the new period");
  const after = await showSub(pc, st.subscriptionPda, "after rollover pull");
  check(after.amountPulledInPeriod === 20n * UNIT, "S1 amountPulledInPeriod reset then counts 20");
  const k = (Number(after.currentPeriodStartTs) - Number(before.currentPeriodStartTs)) / 3600;
  check(Number.isInteger(k) && k >= 1, `S1 period start advanced by a whole number of periods (${k}), anchored to subscribe time`);
}

const phase = process.argv[2];
if (phase === "setup") await setup();
else if (phase === "pulls") await pulls();
else if (phase === "rollover") await rollover();
else console.log("usage: node s1-partial-pulls.ts setup|pulls|rollover");
