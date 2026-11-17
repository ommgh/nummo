// Vitest global setup for the db project: make sure the test database exists.
import { ensureDatabase } from "../packages/db/src/client.ts";

export default async function setup() {
  await ensureDatabase(process.env.TEST_DATABASE_URL ?? "postgres://nummo:nummo@localhost:5434/nummo_test");
}
