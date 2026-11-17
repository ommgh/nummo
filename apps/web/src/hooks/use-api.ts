import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/dashboard/session";

/** GET a dashboard endpoint; refetches when the path or the environment changes. */
export function useApi<T>(path: string | null) {
  const { env } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (path === null) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path, { env });
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e as Error);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path, env]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load };
}
