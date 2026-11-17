import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { api, ApiError, getEnv, setEnv as storeEnv } from "@/lib/api";
import type { Env, Session } from "@/lib/types";
import { FullPageSpinner } from "@/components/brand";

type Ctx = { session: Session; env: Env; setEnv: (e: Env) => void; refresh: () => Promise<void> };
const SessionContext = createContext<Ctx | null>(null);

export function useSession() {
  const c = useContext(SessionContext);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}

/** Loads who is signed in; sends visitors to sign in and new users to create their organization. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [env, setEnvState] = useState<Env>(getEnv());
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signed-out" | "no-org" | "error">("loading");
  const location = useLocation();

  const refresh = useCallback(async () => {
    try {
      const s = await api<Session>("/session", { env });
      setSession(s);
      setState(s.org ? "ready" : "no-org");
    } catch (e) {
      setState(e instanceof ApiError && e.status === 401 ? "signed-out" : "error");
    }
  }, [env]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnv = useCallback((e: Env) => {
    storeEnv(e);
    setEnvState(e);
  }, []);

  if (state === "loading") return <FullPageSpinner />;
  if (state === "signed-out") return <Navigate replace to={`/sign-in?next=${encodeURIComponent(location.pathname)}`} />;
  if (state === "no-org") return <Navigate replace to="/onboarding" />;
  if (state === "error" || !session)
    return (
      <div className="grid min-h-svh place-items-center p-6 text-center text-muted-foreground text-sm">
        <div className="space-y-3">
          <p>The dashboard could not reach the API.</p>
          <button className="text-primary underline" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    );
  return <SessionContext.Provider value={{ session, env, setEnv, refresh }}>{children}</SessionContext.Provider>;
}
