import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { DashboardCard } from "@/components/dashboard-card";
import { CheckCircleIcon, ArrowRightIcon, WarningIcon } from "@phosphor-icons/react";
import type { Overview } from "@/lib/types";

export function BillingHealth({ o }: { o: Overview }) {
  const issues = [
    o.pastDue > 0 && { text: `${o.pastDue} subscriber${o.pastDue === 1 ? " is" : "s are"} past due`, to: "/dashboard/customers" },
    o.webhooks.dead > 0 && { text: `${o.webhooks.dead} webhook${o.webhooks.dead === 1 ? "" : "s"} gave up`, to: "/dashboard/webhooks" },
    o.webhooks.failing > 0 && { text: `${o.webhooks.failing} webhook${o.webhooks.failing === 1 ? " is" : "s are"} retrying`, to: "/dashboard/webhooks" },
    !o.webhookEndpoint && { text: "No webhook endpoint registered", to: "/dashboard/webhooks" },
  ].filter(Boolean) as { text: string; to: string }[];

  return (
    <DashboardCard className="gap-0">
      <CardHeader className="border-b">
        <CardTitle className="text-balance text-base">Billing health</CardTitle>
        <CardDescription className="text-pretty">{issues.length ? "A few things need a look." : "Nothing urgent needs your attention."}</CardDescription>
      </CardHeader>
      <CardContent className="flex h-full items-center px-0">
        {issues.length ? (
          <ul className="w-full divide-y">
            {issues.map((i) => (
              <li key={i.text}>
                <Link className="flex items-center gap-3 px-6 py-3.5 text-sm hover:bg-muted/40" to={i.to}>
                  <WarningIcon className="size-4 shrink-0 text-warning" />
                  <span className="flex-1">{i.text}</span>
                  <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CheckCircleIcon aria-hidden="true" className="text-sol-green" />
              </EmptyMedia>
              <EmptyTitle className="font-heading">You're caught up.</EmptyTitle>
              <EmptyDescription className="text-xs">No one past due, and every webhook was delivered.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild variant="ghost">
                <Link to="/dashboard/customers">
                  View customers
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </CardContent>
    </DashboardCard>
  );
}
