/**
 * Builds the published packages into each package's dist/ (JavaScript plus
 * type declarations). Inside the workspace everything runs from src/ with no
 * build; dist/ exists only for npm, where Node will not strip types from files
 * under node_modules.
 *
 *   node scripts/build-packages.ts          # all, in dependency order
 *   node scripts/build-packages.ts sdk cli  # some
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Dependency order: each package's build reads the dist/ of the ones before it.
const ORDER = ["core", "config", "sdk", "solana", "cli"];

const root = join(import.meta.dirname, "..");
const tsc = join(root, "node_modules", ".bin", "tsc");
const wanted = process.argv.slice(2);
const packages = wanted.length ? ORDER.filter((p) => wanted.includes(p)) : ORDER;

for (const name of packages) {
  const dir = join(root, "packages", name);
  const dist = join(dir, "dist");
  rmSync(dist, { recursive: true, force: true });
  execFileSync(tsc, ["-p", join(dir, "tsconfig.build.json")], { stdio: "inherit" });

  // The emitted JavaScript has its imports rewritten to .js; the declarations
  // keep the source's .ts specifiers, which consumers' TypeScript rejects.
  for (const file of walk(dist)) {
    if (!file.endsWith(".d.ts")) continue;
    const text = readFileSync(file, "utf8");
    const fixed = text.replace(/(from\s+|import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, "$1$2$3.js$2");
    if (fixed !== text) writeFileSync(file, fixed);
  }
  if (name === "cli") chmodSync(join(dist, "main.js"), 0o755);
  console.log(`built packages/${name}/dist`);
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
