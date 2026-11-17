/**
 * `nummo login` stores a secret key so other commands need no environment
 * variable. The file lives in the user's config directory with mode 0600.
 * NUMMO_SECRET_KEY and NUMMO_API_URL, when set, always win.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Credentials = { apiUrl: string; secretKey: string };

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || (process.platform === "win32" ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : join(homedir(), ".config"));
  return join(base, "nummo", "credentials.json");
}

export function readCredentials(path = credentialsPath()): Credentials | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials>;
    return c.secretKey && c.apiUrl ? { apiUrl: c.apiUrl, secretKey: c.secretKey } : null;
  } catch {
    return null;
  }
}

export function writeCredentials(c: Credentials, path = credentialsPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function removeCredentials(path = credentialsPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Key and URL for this run: environment first, then the stored login. */
export function resolveAuth(env: NodeJS.ProcessEnv = process.env): { secretKey?: string; baseUrl?: string } {
  const stored = readCredentials(credentialsPath(env));
  return {
    secretKey: env.NUMMO_SECRET_KEY ?? stored?.secretKey,
    baseUrl: env.NUMMO_API_URL ?? stored?.apiUrl,
  };
}
