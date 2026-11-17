// Create an org with API keys.
//   node apps/api/src/bootstrap.ts "Acme AI"            a test key (devnet)
//   node apps/api/src/bootstrap.ts "Acme AI" --live     a test key and a live key (mainnet)
//   node apps/api/src/bootstrap.ts --org org_... --live  add a live key to an existing org
import { parseArgs } from "node:util";
import { createApiKey, createDb, createOrg, runMigrations } from "@usenummo/db";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { live: { type: "boolean", default: false }, org: { type: "string" } } });
const { db, close } = createDb();
await runMigrations(db);
const orgId = values.org ?? (await createOrg(db, positionals[0] ?? "Local merchant"));
console.log(`org      ${orgId}`);
// A new org gets a test key; --live adds a live one. For an existing org, --live means only a live key.
if (!values.org || !values.live) console.log(`test key ${(await createApiKey(db, orgId, "test")).key}`);
if (values.live) console.log(`live key ${(await createApiKey(db, orgId, "live")).key}`);
console.log(`\nKeys are shown once. Put one in NUMMO_SECRET_KEY, or sign in to the dashboard with it.`);
await close();
