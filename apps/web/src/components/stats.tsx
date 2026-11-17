import { CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardCard } from "@/components/dashboard-card";
import type { Overview } from "@/lib/types";
import { usdc } from "@/lib/format";
import { cn } from "@/lib/utils";

export function DashboardStats({ o }: { o: Overview }) {
  const stats = [
    { label: "Customers", value: o.customers.toLocaleString(), foot: `${o.paidSubscribers} on a paid plan` },
    { label: "Paid subscribers", value: o.paidSubscribers.toLocaleString(), foot: o.pastDue ? `${o.pastDue} past due` : o.canceling ? `${o.canceling} canceling` : "none past due", bad: o.pastDue > 0 },
    { label: "Run rate, 30 days", value: usdc(o.runRate30d, { compact: true }), unit: "USDC", foot: "base fees of live plans" },
    { label: "Collected, 30 days", value: usdc(o.collected30d, { compact: true }), unit: "USDC", foot: `${o.payments30d} payment${o.payments30d === 1 ? "" : "s"} on-chain` },
  ];
  return (
    <>
      {stats.map((s) => (
        <DashboardCard key={s.label}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="font-normal text-muted-foreground text-xs uppercase tracking-wider">{s.label}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-row items-baseline gap-1.5">
            <p className="font-display font-semibold text-3xl tabular-nums tracking-tight">{s.value}</p>
            {s.unit && <span className="text-muted-foreground text-xs">{s.unit}</span>}
          </CardContent>
          <CardFooter className={cn("gap-1 rounded-none bg-background text-muted-foreground text-xs", s.bad && "text-destructive")}>{s.foot}</CardFooter>
        </DashboardCard>
      ))}
    </>
  );
}
