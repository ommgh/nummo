import { CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DashboardCard } from "@/components/dashboard-card";
import type { Overview } from "@/lib/types";
import { usdc } from "@/lib/format";
import { cn } from "@/lib/utils";

const SWATCH = ["bg-cobalt", "bg-tangerine", "bg-marigold", "bg-iris"];

export function DashboardStats({ o }: { o: Overview }) {
  const stats = [
    { label: "Customers", value: o.customers.toLocaleString(), foot: `${o.paidSubscribers} on a paid plan` },
    { label: "Paid subscribers", value: o.paidSubscribers.toLocaleString(), foot: o.pastDue ? `${o.pastDue} past due` : o.canceling ? `${o.canceling} canceling` : "none past due", bad: o.pastDue > 0 },
    { label: "Run rate, 30 days", value: usdc(o.runRate30d, { compact: true }), unit: "USDC", foot: "base fees of live plans" },
    {
      label: "Collected, 30 days",
      value: usdc(o.collected30d, { compact: true }),
      unit: "USDC",
      foot: o.agentPayments30d?.count
        ? `${o.payments30d} payments, ${o.agentPayments30d.count} by ${o.agentPayments30d.wallets} agent${o.agentPayments30d.wallets === 1 ? "" : "s"}`
        : `${o.payments30d} payment${o.payments30d === 1 ? "" : "s"} on-chain`,
    },
  ];
  return (
    <>
      {stats.map((s, i) => (
        <DashboardCard key={s.label}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="label-mono flex items-center gap-2 font-normal text-muted-foreground">
              <span className={cn("size-2", SWATCH[i])} />
              {s.label}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-row items-baseline gap-1.5">
            <p className="font-medium text-4xl tabular-nums tracking-[-0.04em]">{s.value}</p>
            {s.unit && <span className="font-mono text-[11px] text-muted-foreground tracking-wide">{s.unit}</span>}
          </CardContent>
          <CardFooter className={cn("gap-1 rounded-none bg-card text-[13px] text-muted-foreground", s.bad && "text-destructive")}>{s.foot}</CardFooter>
        </DashboardCard>
      ))}
    </>
  );
}
