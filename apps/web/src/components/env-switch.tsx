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
        "flex items-center gap-1.5 px-2.5 py-1 text-[11px] uppercase tracking-wider transition-colors",
        env === value ? (value === "live" ? "bg-sol-green/15 text-sol-green" : "bg-warning/15 text-warning") : "text-muted-foreground hover:text-foreground",
      )}
      onClick={() => setEnv(value)}
      type="button"
    >
      <span className={cn("size-1.5 rounded-full", value === "live" ? "bg-sol-green" : "bg-warning", env !== value && "opacity-40")} />
      {label}
    </button>
  );
  return (
    <div className="flex border" role="group" aria-label="Environment">
      {option("test", "Test")}
      {option("live", "Live")}
    </div>
  );
}
