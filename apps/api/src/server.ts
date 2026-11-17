import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "@usenummo/db";
import { chainsFromEnv, settingsFromEnv } from "@usenummo/settlement";
import { createApp } from "./app.ts";

const { db } = createDb();
if (process.env.MIGRATE_ON_START !== "0") await runMigrations(db);
const chains = await chainsFromEnv();
const settings = settingsFromEnv();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(db, { chains, settings }).fetch, port }, (info) => {
  console.log(`nummo API listening on http://localhost:${info.port}`);
  for (const [env, chain] of Object.entries(chains)) console.log(`  ${env}: settling on ${chain.network} in ${chain.mint}, puller ${chain.pullerAddress}`);
  if (Object.keys(chains).length === 0) console.log("  settlement off: set NUMMO_TEST_PULLER_KEY to enable checkout on devnet");
});
