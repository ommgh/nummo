import { BillingHealth } from "@/components/billing-health";
import { UsageChart } from "@/components/channel-sales-chart";
import { DashboardActivity } from "@/components/dashboard-activity";
import { RecentPayments } from "@/components/dashboard-invoices";
import { NetRevenueChart } from "@/components/net-revenue-chart";
import { DashboardStats } from "@/components/stats";
import type { Overview } from "@/lib/types";

/** The efferd dashboard-2 grid: KPIs, collected per day, usage, payments, health, activity. */
export function Dashboard({ o }: { o: Overview }) {
  return (
    <div className="grid grid-cols-1 gap-px border bg-border md:grid-cols-2 lg:grid-cols-4">
      <DashboardStats o={o} />
      <NetRevenueChart o={o} />
      <UsageChart u={o.usageDaily} />
      <RecentPayments payments={o.recentPayments} />
      <BillingHealth o={o} />
      <DashboardActivity o={o} />
    </div>
  );
}
