// The settlement worker, reconciler and webhook dispatcher in one process (doc 02, components).
// Needs DATABASE_URL and, per environment it settles, NUMMO_TEST_PULLER_KEY / NUMMO_LIVE_PULLER_KEY.
import { createDb, runMigrations } from "@usenummo/db";
import { chainsFromEnv, parseDuration, runWorker, settingsFromEnv } from "@usenummo/settlement";

const { db, close } = createDb();
if (process.env.MIGRATE_ON_START !== "0") await runMigrations(db);
const chains = await chainsFromEnv();
const settings = settingsFromEnv();
if (Object.keys(chains).length === 0) console.log("no chain configured: only webhooks will be delivered (set NUMMO_TEST_PULLER_KEY)");
for (const [env, chain] of Object.entries(chains)) console.log(`${env}: settling on ${chain.network} in ${chain.mint}, puller ${chain.pullerAddress}`);

const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());

await runWorker(db, chains, settings, {
  settleEveryMs: parseDuration(process.env.NUMMO_SETTLE_EVERY ?? "10s"),
  reconcileEveryMs: parseDuration(process.env.NUMMO_RECONCILE_EVERY ?? "2m"),
  dispatchEveryMs: parseDuration(process.env.NUMMO_DISPATCH_EVERY ?? "2s"),
  signal: stop.signal,
});
await close();
