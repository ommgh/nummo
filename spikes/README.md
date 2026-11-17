# Spikes

Throwaway experiments that settle the assumptions in [docs/05-roadmap-and-grant.md](../docs/05-roadmap-and-grant.md). Not part of the product.

```bash
cd spikes && pnpm install
node s1-partial-pulls.ts setup      # needs ~1 devnet SOL in .keys/merchant.json's address
node s1-partial-pulls.ts pulls      # resume the partial pulls if setup was interrupted
node s1-partial-pulls.ts rollover   # after the 1-hour period ends
```

Devnet's public airdrop returns HTTP 410, so fund the merchant address the script prints at https://faucet.solana.com. The public RPC also rate-limits (HTTP 429); the script retries those with backoff, and only program errors count as rejections.

## Results

Checked 2026-11-17 against program source commit `57290f4` (2026-11-15) and `@solana/subscriptions` 0.5.0.

### S1. Partial pulls within one period: yes, confirmed on devnet

`transfer_subscription.rs` calls `validate_recurring_transfer` (`program/src/instructions/helpers/transfer_validation.rs`):

- Each pull adds its amount to `amount_pulled_in_period` and is rejected with `AmountExceedsPeriodLimit` (custom error **400**) only when `amount_pulled_in_period + amount > terms.amount`.
- A zero amount is rejected with `InvalidAmount` (129).
- **Period boundary:** on the first pull at or after `current_period_start_ts + period`, the start advances by a whole number of periods (`start + k * period`) and the counter resets to 0. Periods are anchored to the subscribe time, not to the time of the first pull. So our worker can compute every boundary from the subscription's `currentPeriodStartTs`, and a pull that lands just after a boundary counts against the new period.
- Missed periods do not accumulate (fact 7 in doc 03 holds): there is one counter, and it is reset rather than carried over.
- The program's own integration tests cover `test_transfer_subscription_multiple_pulls_within_period`, `..._exceeds_period_limit` and `..._period_rollover`.

Decision D3 holds. Devnet run on 2026-11-17, plan of 70 tokens per 1 hour on a 6-decimal test mint, puller listed, destination locked to the merchant:

| Step | Result |
| --- | --- |
| Pull 20 (inside the activation transaction) | ok |
| Pull 5, total 25 | ok `3WjCyLpC…` |
| Pull 5, total 30 | ok `2RzucEZB…` |
| Pull 50, would be 80 | rejected, error 400 `AmountExceedsPeriodLimit` |
| Pull 40, total exactly 70 | ok `2axUMM23…` |
| Pull 1 base unit, would be 70.000001 | rejected, error 400 |
| Subscriber record | `amountPulledInPeriod` = 70; merchant received exactly 70; subscriber kept 130 |
| Pull 20 in the next period | pending: the period ends at 12:21 UTC on 2026-11-17 |

### Other facts confirmed from source

- **Max pullers:** 4 (`MAX_PLAN_PULLERS`), plus the owner, who can always pull. **Max destinations:** 4. Zero-padded slots are ignored.
- **Who pays rent on subscribe:** an optional `payer` account, defaulting to the subscriber. The SDK's `payer` field on `initSubscriptionAuthority` and `subscribe` lets the puller pay rent, so the customer needs no SOL. The subscription record stores `header.payer`. Sponsored rent is not recoverable by the sponsor alone (SDK README), so the hosted product should set rent quotas.
- **Cancellation:** sets `expires_at_ts` to the end of the current period. Pulls are allowed until then and rejected with `SubscriptionCancelled` (508) after.
- **Plan expiry:** pulls fail with `PlanExpired` (501) once `end_ts` passes. Sunset plans still allow pulls.
- **`UNKNOWN_INIT_ID`** is `i64::MIN`. It makes `subscribe` require that the authority was created in the same slot, which is what lets activation bundle `initSubscriptionAuthority` + `subscribe`.

### S2. One-signature activation: yes, confirmed on devnet

One transaction with `initSubscriptionAuthority` + `subscribe` (with `UNKNOWN_INIT_ID`) + the first `transferSubscription` of 20 landed (`3yEvkkUj…`). The subscriber signed and holds **zero SOL**; the puller was fee payer and rent payer for both new accounts and spent **0.00263636 SOL** in total. The subscription record's `header.payer` is the puller. No compute-budget instructions were needed on devnet; mainnet should still set a priority fee.

### S3. Reading state and events: partly answered

`fetchSubscriptionDelegation` decodes `amountPulledInPeriod`, `currentPeriodStartTs`, `expiresAtTs` and the header. Event decoding from a transaction is still to do.
