/**
 * An agent that pays the demo per request (milestone M4). It has a Solana
 * wallet holding devnet USDC and no account: each call to /agent/chat is
 * answered with 402 Payment Required, the agent pays 0.01 USDC, and the reply
 * comes back with a receipt. nummo's puller pays the network fee, so the wallet
 * needs no SOL. The payments appear in the dashboard under the customer
 * `wallet:<address>`, next to the subscribers.
 *
 *   node --env-file-if-exists=../../.env src/agent.ts <keypair.json> [calls] [x402|mpp]
 *
 * DEMO_URL (default http://localhost:3000) and AGENT_RPC_URL (default devnet)
 * can be set. Fund the wallet with devnet USDC at https://faucet.circle.com.
 */

import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { ClientPermissions, PayKitClient, usd } from "@solana/pay-kit/client";

const [keyFile, callsArg = "3", only] = process.argv.slice(2);
if (!keyFile) {
  console.error("usage: agent.ts <keypair.json> [calls] [x402|mpp]");
  process.exit(1);
}
const demo = (process.env.DEMO_URL ?? "http://localhost:3000").replace(/\/$/, "");
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8")) as number[]));

// Spend controls: only this demo, only devnet, at most 0.05 USDC per payment.
const permissions = ClientPermissions.builder().allowOrigin(new URL(demo).origin).onlyNetwork("devnet").maxAmountPerPayment(usd("0.05")).build();
const client = await PayKitClient.builder()
  .signer(signer)
  .rpcUrl(process.env.AGENT_RPC_URL ?? "https://api.devnet.solana.com")
  .network("devnet")
  .permissions(permissions)
  .build();

console.log(`agent ${signer.address} calling ${demo}/agent/chat`);
const calls = Number(callsArg);
for (let i = 0; i < calls; i++) {
  const protocol = (only as "x402" | "mpp" | undefined) ?? (i % 2 === 0 ? "x402" : "mpp");
  const started = Date.now();
  const res = await client.fetch(
    `${demo}/agent/chat`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: `question ${i + 1}` }) },
    protocol,
  );
  const body = await res.text();
  // x402 answers with PAYMENT-RESPONSE (pay-kit sends it as x-payment-response), MPP with Payment-Receipt.
  const receipt = res.headers.get("payment-response") ?? res.headers.get("x-payment-response") ?? res.headers.get("payment-receipt");
  console.log(`${i + 1}. ${protocol} ${res.status} in ${Date.now() - started} ms: ${body}`);
  if (receipt) console.log(`   receipt ${receipt.slice(0, 120)}${receipt.length > 120 ? "…" : ""}`);
  if (!res.ok) process.exitCode = 1;
}
