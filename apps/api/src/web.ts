/**
 * Serves the website and the dashboard: the React app in apps/web, built to
 * apps/web/dist (`pnpm --filter @usenummo/web build`). Hashed assets are cached
 * for a year; every page route gets index.html and the app routes on the client.
 *
 * Without a build (tests, API-only development) the routes answer with a short
 * note instead; run `pnpm dev:web` for the app with hot reload.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { type Context, Hono } from "hono";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

export const DEFAULT_WEB_DIR = resolve(import.meta.dirname, "../../web/dist");

export function webApp(dir: string | null = DEFAULT_WEB_DIR) {
  const app = new Hono();
  const root = dir && existsSync(join(dir, "index.html")) ? dir : null;
  const index = root ? readFileSync(join(root, "index.html"), "utf8") : null;

  const page = () => (c: Context) =>
    c.html(
      index ??
        `<!doctype html><meta charset="utf-8"><title>nummo</title><p style="font:15px system-ui;margin:2rem">The web app is not built. Run <code>pnpm --filter @usenummo/web build</code>, or <code>pnpm dev:web</code> for development.</p>`,
    );

  // Static files at the root of the build (assets/, favicon.svg, og.png, robots.txt).
  app.get("*", async (c, next) => {
    if (!root) return next();
    const rel = normalize(decodeURIComponent(c.req.path)).replace(/^([/\\])+/, "");
    if (!rel || rel.startsWith("..") || !extname(rel)) return next();
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
    const immutable = rel.startsWith("assets/");
    return c.body(readFileSync(file), 200, {
      "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    });
  });

  for (const path of ["/", "/sign-in", "/sign-up", "/onboarding"]) app.get(path, page());
  app.get("/dashboard", page());
  app.get("/dashboard/*", page());
  return app;
}
