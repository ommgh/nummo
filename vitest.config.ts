import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          setupFiles: ["./test/fc-setup.ts"],
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          exclude: ["**/*.db.test.ts", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "db",
          // Its own database, so test rows never reach a worker settling the development database.
          globalSetup: ["./test/db-setup.ts"],
          env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://nummo:nummo@localhost:5434/nummo_test" },
          include: ["packages/*/test/**/*.db.test.ts", "apps/*/test/**/*.db.test.ts"],
          // These share one Postgres database.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
