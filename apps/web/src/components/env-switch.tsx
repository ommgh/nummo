import { cn } from "@/lib/utils";
import { useSession } from "@/dashboard/session";
import type { Env } from "@/lib/types";

/** Test (devnet) or live (mainnet) data: the same switch Stripe and Autumn have. */
export function EnvSwitch() {
  const { env, setEnv } = useSession();
  const option = (value: Env, label: string) => (
    <button
      aria-pressed={env === value}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.08em] transition-colors",
        env === value ? (value === "live" ? "bg-cobalt text-white" : "bg-marigold text-ink") : "text-muted-foreground hover:text-foreground",
      )}
      onClick={() => setEnv(value)}
      type="button"
    >
      <span className={cn("size-1.5", env === value ? "bg-current" : value === "live" ? "bg-cobalt" : "bg-marigold")} />
      {label}
    </button>
  );
  return (
    <div aria-label="Environment" className="flex rounded-full border p-0.5" role="group">
      {option("test", "Test")}
      {option("live", "Live")}
    </div>
  );
}
