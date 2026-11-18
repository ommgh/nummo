import { Link } from "react-router";
import { CoinsIcon } from "@phosphor-icons/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import type { Payment } from "@/lib/types";
import { dateTime, paymentKind, usdc } from "@/lib/format";
import { EmptyNote, ErrorNote, LoadingRows, PageHeader, Panel, StatusBadge, TxLink } from "@/dashboard/ui";

export function PaymentsPage() {
  const { data, error, reload } = useApi<{ payments: Payment[] }>("/payments");
  const total = data?.payments.filter((p) => p.status !== "reverted").reduce((s, p) => s + Number(p.amount), 0) ?? 0;
  return (
    <>
      <PageHeader description="Every USDC movement nummo made for you: renewals, overage, top-ups, checkouts, and requests agents paid for over x402 or MPP. Each links to its Solana transaction." title="Payments" />
      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingRows />
      ) : (
        <Panel actions={<span className="text-muted-foreground text-xs tabular-nums">{usdc(total)} USDC in view</span>} title={`${data.payments.length} payment${data.payments.length === 1 ? "" : "s"}`}>
          {data.payments.length === 0 ? (
            <EmptyNote icon={<CoinsIcon />} title="No payments yet">
              Payments appear once a customer subscribes to a paid plan, buys a top-up, or an agent pays for a request.
            </EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="ps-5">When</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>For</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="pe-5">Transaction</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.payments.map((p) => (
                    <TableRow className="h-12" key={p.id}>
                      <TableCell className="ps-5 text-muted-foreground">{dateTime(p.createdAt)}</TableCell>
                      <TableCell>
                        <Link className="hover:text-primary" to={`/dashboard/customers/${encodeURIComponent(p.customerId)}`}>
                          {p.customerId}
                        </Link>
                      </TableCell>
                      <TableCell>{paymentKind(p.kind, p.protocol)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usdc(p.amount)} USDC</TableCell>
                      <TableCell>
                        <StatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="pe-5">
                        <TxLink signature={p.signature} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
