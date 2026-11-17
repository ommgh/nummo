import { describe, expect, test } from "vitest";
import { classify } from "../src/errors.ts";
import { FakeChain } from "../src/fake-chain.ts";

const U = 1_000_000n;

/** The S1 table from spikes/README.md, replayed against the fake. */
describe("FakeChain follows the program as observed on devnet (spike S1)", () => {
  test("partial pulls up to the plan amount, then rejection with 400; rollover resets", async () => {
    const chain = new FakeChain();
    const plan = chain.createPlan({ owner: "merchant", amount: 70n * U, periodHours: 1 });
    const wallet = chain.wallet(200n * U);
    const built = await chain.buildActivation({ plan, subscriber: wallet, firstPull: 20n * U });
    const tx = await chain.cosign(chain.walletSign(built.transaction, wallet), built.message, wallet, built.lastValidBlockHeight);
    expect(await chain.send(tx)).toEqual({ ok: true });
    const subAddr = await chain.findSubscriptionAddress(plan.address, wallet);

    const pull = async (amount: bigint) => {
      const r = await chain.send(await chain.preparePull({ plan, subscriptionAddress: subAddr, subscriber: wallet, amount }));
      return r.ok ? "ok" : r.error.code;
    };
    expect(await pull(5n * U)).toBe("ok");
    expect(await pull(5n * U)).toBe("ok");
    expect(await pull(50n * U)).toBe(400);
    expect(await pull(40n * U)).toBe("ok");
    expect(await pull(1n)).toBe(400);
    const s = (await chain.getSubscription(subAddr))!;
    expect(s.amountPulledInPeriod).toBe(70n * U);
    expect(chain.balances.get("merchant")).toBe(70n * U);
    expect(chain.balances.get(wallet)).toBe(130n * U);

    chain.advance(2.5 * 3_600_000);
    expect(await pull(20n * U)).toBe("ok");
    const after = (await chain.getSubscription(subAddr))!;
    expect(after.amountPulledInPeriod).toBe(20n * U);
    expect(after.currentPeriodStart.getTime() - s.currentPeriodStart.getTime()).toBe(2 * 3_600_000); // whole periods, anchored
  });

  test("cancel ends pulls at the period end with 508; a short balance fails with token error 1", async () => {
    const chain = new FakeChain();
    const plan = chain.createPlan({ owner: "m", amount: 10n * U, periodHours: 1 });
    const wallet = chain.wallet(3n * U);
    const b = await chain.buildActivation({ plan, subscriber: wallet, firstPull: 2n * U });
    await chain.send(await chain.cosign(chain.walletSign(b.transaction, wallet), b.message, wallet, b.lastValidBlockHeight));
    const subAddr = await chain.findSubscriptionAddress(plan.address, wallet);
    const pull = async (amount: bigint) => {
      const r = await chain.send(await chain.preparePull({ plan, subscriptionAddress: subAddr, subscriber: wallet, amount }));
      return r.ok ? "ok" : r.error.kind;
    };
    expect(await pull(2n * U)).toBe("insufficient_funds");
    chain.cancel(subAddr);
    expect(await pull(1n * U)).toBe("ok"); // still inside the period
    chain.advance(3_600_000);
    expect(await pull(1n)).toBe("subscription_cancelled");
  });
});

describe("classify", () => {
  test("status errors map to the reasons doc 03 acts on", () => {
    expect(classify({ InstructionError: [2, { Custom: 1 }] }).kind).toBe("insufficient_funds");
    expect(classify({ InstructionError: [1, { Custom: 400 }] }).kind).toBe("ceiling_reached");
    expect(classify({ InstructionError: [1, { Custom: 508 }] }).kind).toBe("subscription_cancelled");
    expect(classify({ InstructionError: [0, { Custom: 136 }] }).kind).toBe("stale_authority");
    expect(classify("InsufficientFundsForFee").kind).toBe("transient");
    expect(classify(new Error("Transaction simulation failed: Blockhash not found")).kind).toBe("transient");
    expect(classify(new Error("something else")).kind).toBe("unknown");
  });
});
