import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "@bill/db";
import { createApp } from "./app.ts";

const { db } = createDb();
if (process.env.MIGRATE_ON_START !== "0") await runMigrations(db);
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp(db).fetch, port }, (info) => console.log(`bill API listening on http://localhost:${info.port}`));
