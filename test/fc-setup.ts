import fc from "fast-check";

// FC_NUM_RUNS=5000 pnpm test:unit for a deeper property-test run.
const runs = Number(process.env.FC_NUM_RUNS ?? 0);
if (runs > 0) fc.configureGlobal({ numRuns: runs });
