import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, ArrowSquareOutIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { explorerAddress, explorerTx, short } from "@/lib/format";
import { useSession } from "@/dashboard/session";

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="font-display font-semibold text-2xl tracking-tight">{title}</h1>
        {description && <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONE: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  active: "ok",
  paid: "ok",
  delivered: "ok",
  finalized: "ok",
  confirmed: "ok",
  completed: "ok",
  past_due: "bad",
  uncollectible: "bad",
  dead: "bad",
  reverted: "bad",
  failed: "bad",
  canceling: "warn",
  pending: "warn",
  open: "warn",
  retrying: "warn",
  ended: "muted",
  draft: "muted",
  sunset: "muted",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = TONE[status] ?? "muted";
  return (
    <Badge
      className={cn(
        "gap-1.5 border-none font-normal capitalize",
        tone === "ok" && "bg-sol-green/10 text-sol-green",
        tone === "warn" && "bg-warning/10 text-warning",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "muted" && "bg-muted text-muted-foreground",
        className,
      )}
      variant="secondary"
    >
      <span className="size-1.5 rounded-full bg-current" />
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

export function TxLink({ signature }: { signature: string }) {
  const { session } = useSession();
  return (
    <a
      className="inline-flex items-center gap-1 font-mono text-muted-foreground text-xs hover:text-sol-green"
      href={explorerTx(signature, session.settlement?.network)}
      rel="noopener"
      target="_blank"
    >
      {short(signature, 5, 4)}
      <ArrowSquareOutIcon className="size-3" />
    </a>
  );
}

export function AddressLink({ address, className }: { address: string; className?: string }) {
  const { session } = useSession();
  return (
    <a
      className={cn("inline-flex items-center gap-1 font-mono text-xs hover:text-sol-green", className)}
      href={explorerAddress(address, session.settlement?.network)}
      rel="noopener"
      target="_blank"
    >
      {short(address, 5, 4)}
      <ArrowSquareOutIcon className="size-3" />
    </a>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      size="icon-sm"
      variant="ghost"
    >
      {done ? <CheckIcon className="text-sol-green" /> : <CopyIcon />}
    </Button>
  );
}

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton className="h-8 w-full" key={i} />
      ))}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
      <WarningCircleIcon className="size-4 shrink-0" />
      <span className="flex-1">{error.message}</span>
      {onRetry && (
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyNote({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="mb-1 grid size-10 place-items-center border bg-muted/40 text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <p className="font-medium text-sm">{title}</p>
      {children && <div className="max-w-md text-pretty text-muted-foreground text-xs leading-relaxed">{children}</div>}
    </div>
  );
}

/** A bordered panel with a title row, in the dashboard-2 style. */
export function Panel({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border bg-card/40", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-5">
          <div className="min-w-0">
            {title && <h2 className="font-medium text-sm">{title}</h2>}
            {description && <p className="text-muted-foreground text-xs">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Usdc({ value, className }: { value: string; className?: string }) {
  const n = Number(value);
  return (
    <span className={cn("tabular-nums", className)}>
      {Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : value}
      <span className="ml-1 text-[0.8em] text-muted-foreground">USDC</span>
    </span>
  );
}
