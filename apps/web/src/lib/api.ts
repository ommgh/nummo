import type { Env } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ENV_KEY = "nummo.env";

export function getEnv(): Env {
  try {
    return localStorage.getItem(ENV_KEY) === "live" ? "live" : "test";
  } catch {
    return "test";
  }
}

export function setEnv(env: Env) {
  try {
    localStorage.setItem(ENV_KEY, env);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

/** Calls the dashboard API (same origin, session cookie). */
export async function api<T>(path: string, init: { method?: string; body?: unknown; env?: Env } = {}): Promise<T> {
  const r = await fetch(`/dashboard/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "x-nummo-env": init.env ?? getEnv(),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (!r.ok) throw new ApiError(r.status, j.error?.code ?? "error", j.error?.message ?? `HTTP ${r.status}`);
  return j as T;
}
