import { serve } from "@hono/node-server";
import { agentPaymentsFromEnv } from "@usenummo/agents";
import { createDb, runMigrations } from "@usenummo/db";
import { chainsFromEnv, settingsFromEnv } from "@usenummo/settlement";
import { createApp } from "./app.ts";

const { db } = createDb();
if (process.env.MIGRATE_ON_START !== "0") await runMigrations(db);
const chains = await chainsFromEnv();
const settings = settingsFromEnv();
const agents = await agentPaymentsFromEnv(db);
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(db, { chains, settings, agents }).fetch, port }, (info) => {
  console.log(`nummo API listening on http://localhost:${info.port}`);
  for (const [env, chain] of Object.entries(chains)) {
    console.log(`  ${env}: settling on ${chain.network} in ${chain.mint}, puller ${chain.pullerAddress}${agents.enabled(env as "test") ? "; agent payments (x402, MPP) on" : ""}`);
  }
  if (Object.keys(chains).length === 0) console.log("  settlement off: set NUMMO_TEST_PULLER_KEY to enable checkout on devnet");
});
