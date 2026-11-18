import { cn } from "@/lib/utils";
import { useSession } from "@/dashboard/session";
import { short } from "@/lib/format";

/** Where this environment settles, in the sidebar footer. */
export function LatestChange() {
  const { session, env } = useSession();
  const s = session.settlement;
  return (
    <div
      className={cn(
        "relative flex min-h-24 flex-col justify-center gap-1 overflow-hidden border-t px-4 py-3 *:text-nowrap",
        "transition-opacity group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0",
      )}
    >
      <div aria-hidden className="pointer-events-none absolute top-3 right-3 flex gap-1">
        <span className="size-1.5 bg-cobalt" />
        <span className="size-1.5 bg-tangerine" />
        <span className="size-1.5 bg-marigold" />
      </div>
      <span className="label-mono text-[10px] text-muted-foreground">Settlement</span>
      {s ? (
        <>
          <p className="flex items-center gap-1.5 font-medium text-xs">
            <span className={cn("size-1.5", env === "live" ? "bg-lime" : "bg-marigold")} />
            USDC on Solana {s.network}
          </p>
          <span className="text-[10px] text-muted-foreground">puller {short(s.puller, 6, 4)}</span>
        </>
      ) : (
        <>
          <p className="font-medium text-xs">Off for {env === "live" ? "mainnet" : "devnet"}</p>
          <span className="text-[10px] text-muted-foreground">Set NUMMO_{env.toUpperCase()}_PULLER_KEY</span>
        </>
      )}
    </div>
  );
}
