import { useEffect, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "nummo-theme";
const listeners = new Set<() => void>();
let current: Theme = read();

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function setTheme(t: Theme) {
  current = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  for (const f of listeners) f();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => current,
    () => "light",
  );
}

/**
 * Puts the saved theme on <html> while mounted. Only the dashboard calls it:
 * the website and sign-in pages are designed as fixed paper and ink panels.
 */
export function useApplyTheme() {
  const t = useTheme();
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", t === "dark");
    return () => el.classList.remove("dark");
  }, [t]);
}
