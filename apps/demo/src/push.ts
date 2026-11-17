// Stand-in for `bill push` until the CLI lands: shows the diff, then applies.
import { toDocument } from "@bill/config";
import { Bill } from "@bill/sdk";
import config from "../bill.config.ts";

const bill = new Bill();
const doc = toDocument(config);
const dry = await bill.config.push(doc, { dryRun: true });
for (const c of dry.changes) if (c.action !== "unchanged") console.log(`  ${c.action.padEnd(8)} ${c.kind} ${c.id}`);
await bill.config.push(doc);
console.log("config applied");
