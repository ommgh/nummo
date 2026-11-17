// Create an org with API keys, or give an existing org a dashboard owner.
//   node apps/api/src/bootstrap.ts "Acme AI"                       a test key (devnet)
//   node apps/api/src/bootstrap.ts "Acme AI" --live                a test key and a live key (mainnet)
//   node apps/api/src/bootstrap.ts --org org_... --live             add a live key to an existing org
//   node apps/api/src/bootstrap.ts --org org_... --owner a@b.com    make a signed-up user the org's owner in the dashboard
// Most people never need this: signing up in the dashboard creates the org, and keys are made there.
import { parseArgs } from "node:util";
import { addOrgOwner, createApiKey, createDb, createOrg, runMigrations } from "@usenummo/db";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { live: { type: "boolean", default: false }, org: { type: "string" }, owner: { type: "string" } },
});
const { db, close } = createDb();
await runMigrations(db);
const orgId = values.org ?? (await createOrg(db, positionals[0] ?? "Local merchant"));
console.log(`org      ${orgId}`);
if (values.owner) {
  const r = await addOrgOwner(db, orgId, values.owner);
  console.log(r ? `owner    ${values.owner} can now open this org in the dashboard` : `no dashboard account for ${values.owner}: sign up first, then run this again`);
}
// A new org gets a test key; --live adds a live one. For an existing org, --live means only a live key.
if (!values.org || values.live) {
  if (!values.org || !values.live) console.log(`test key ${(await createApiKey(db, orgId, "test")).key}`);
  if (values.live) console.log(`live key ${(await createApiKey(db, orgId, "live")).key}`);
  console.log(`\nKeys are shown once. Put one in NUMMO_SECRET_KEY.`);
}
await close();
