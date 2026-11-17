// Stand-in for `nummo push` until the CLI lands: shows the diff, then applies.
import { toDocument } from "@nummo/config";
import { Nummo } from "@nummo/sdk";
import config from "../nummo.config.ts";

const nummo = new Nummo();
const doc = toDocument(config);
const dry = await nummo.config.push(doc, { dryRun: true });
for (const c of dry.changes) if (c.action !== "unchanged") console.log(`  ${c.action.padEnd(8)} ${c.kind} ${c.id}`);
await nummo.config.push(doc);
console.log("config applied");
