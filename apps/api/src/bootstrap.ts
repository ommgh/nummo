// Create an org with a test API key. Usage: node apps/api/src/bootstrap.ts "Acme AI"
import { createApiKey, createDb, createOrg, runMigrations } from "@nummo/db";

const name = process.argv[2] ?? "Local merchant";
const { db, close } = createDb();
await runMigrations(db);
const orgId = await createOrg(db, name);
const { key } = await createApiKey(db, orgId, "test");
console.log(`org      ${orgId}\ntest key ${key}\n\nThe key is shown once. Put it in NUMMO_SECRET_KEY.`);
await close();
