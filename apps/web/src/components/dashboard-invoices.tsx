import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DashboardCard } from "@/components/dashboard-card";
import { ArrowRightIcon, CoinsIcon } from "@phosphor-icons/react";
import type { Payment } from "@/lib/types";
import { ago, usdc } from "@/lib/format";
import { EmptyNote, StatusBadge } from "@/dashboard/ui";

export function RecentPayments({ payments }: { payments: Payment[] }) {
  return (
    <DashboardCard className="relative gap-0 md:col-span-2">
      <CardHeader className="border-b">
        <CardTitle className="text-base">Recent payments</CardTitle>
        <CardDescription>Pulls and transfers settled on Solana.</CardDescription>
      </CardHeader>
      <CardContent className="mask-b-from-60% mask-b-to-100% px-0">
        {payments.length === 0 ? (
          <EmptyNote icon={<CoinsIcon />} title="No payments yet">
            The first subscription renewal, overage pull or top-up shows up here with its transaction.
          </EmptyNote>
        ) : (
          <Table>
            <TableCaption className="sr-only">Recent payments with customer, kind, amount and status.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="ps-6">Customer</TableHead>
                <TableHead>For</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pe-6 text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.slice(0, 6).map((p) => (
                <TableRow className="h-12" key={p.id}>
                  <TableCell className="max-w-40 truncate ps-6 font-medium">
                    <Link className="hover:text-sol-green" to={`/dashboard/customers/${encodeURIComponent(p.customerId)}`}>
                      {p.customerId}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">{ago(p.createdAt)}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground capitalize">{p.kind}</TableCell>
                  <TableCell>
                    <StatusBadge status={p.status} />
                  </TableCell>
                  <TableCell className="pe-6 text-right tabular-nums">{usdc(p.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {payments.length > 0 && (
        <div className="mask-t-from-30% absolute inset-x-0 bottom-0 flex h-1/5 items-center justify-center bg-background">
          <Button asChild className="relative" variant="ghost">
            <Link to="/dashboard/payments">
              All payments
              <ArrowRightIcon aria-hidden="true" />
            </Link>
          </Button>
        </div>
      )}
    </DashboardCard>
  );
}
