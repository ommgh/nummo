import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardCard } from "@/components/dashboard-card";
import { CoinsIcon, UserPlusIcon, ArrowsClockwiseIcon, XCircleIcon, LightningIcon, ReceiptIcon } from "@phosphor-icons/react";
import type { Overview } from "@/lib/types";
import { ago, eventLabel } from "@/lib/format";
import { EmptyNote } from "@/dashboard/ui";

function iconFor(type: string) {
  if (type.includes("payment")) return <CoinsIcon />;
  if (type.includes("invoice")) return <ReceiptIcon />;
  if (type.includes("cancel") || type.includes("ended") || type.includes("failed")) return <XCircleIcon />;
  if (type.includes("subscription") || type.includes("renew")) return <ArrowsClockwiseIcon />;
  if (type.includes("customer")) return <UserPlusIcon />;
  return <LightningIcon />;
}

function subject(payload: unknown) {
  const p = payload as Record<string, unknown> | null;
  const c = (p?.customerId ?? (p?.customer as Record<string, unknown> | undefined)?.id) as string | undefined;
  return c ? ` · ${c}` : "";
}

export function DashboardActivity({ o }: { o: Overview }) {
  return (
    <DashboardCard className="gap-0">
      <CardHeader className="border-b">
        <CardTitle>Activity</CardTitle>
        <CardDescription>The latest billing events.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {o.activity.length === 0 ? (
          <EmptyNote icon={<LightningIcon />} title="Quiet so far">
            Subscriptions, payments and plan changes appear here as they happen.
          </EmptyNote>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {o.activity.slice(0, 5).map((item, i) => (
              <li className="flex h-16 items-center gap-3 px-6" key={`${item.type}-${item.createdAt}-${i}`}>
                <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center border bg-muted/30 text-sol-purple [&_svg]:size-4">
                  {iconFor(item.type)}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="line-clamp-1 text-pretty text-foreground text-sm leading-snug">
                    {eventLabel(item.type)}
                    <span className="text-muted-foreground">{subject(item.payload)}</span>
                  </p>
                  <p className="text-muted-foreground text-xs">{ago(item.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </DashboardCard>
  );
}
