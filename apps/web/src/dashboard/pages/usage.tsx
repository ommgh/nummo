import { Link, useSearchParams } from "react-router";
import { ChartLineUpIcon } from "@phosphor-icons/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UsageChart } from "@/components/channel-sales-chart";
import { useApi } from "@/hooks/use-api";
import type { UsageDaily, UsageEvent } from "@/lib/types";
import { compact, dateTime, num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmptyNote, ErrorNote, LoadingRows, PageHeader, Panel } from "@/dashboard/ui";

export function UsagePage() {
  const [params, setParams] = useSearchParams();
  const feature = params.get("feature") ?? "";
  const { data, error, reload } = useApi<{ features: { featureId: string; total: string; events: number }[]; daily: UsageDaily; events: UsageEvent[] }>(
    `/usage${feature ? `?feature=${encodeURIComponent(feature)}` : ""}`,
  );
  return (
    <>
      <PageHeader description="What your customers used, from every track() call. Balances and overage are worked out from these events." title="Usage" />
      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingRows />
      ) : (
        <div className="grid gap-6">
          {data.features.length > 0 && (
            <div className="grid grid-cols-2 gap-px border bg-border md:grid-cols-3 xl:grid-cols-6">
              {data.features.map((f) => (
                <button
                  className={cn("bg-background p-4 text-left transition-colors hover:bg-muted/30", feature === f.featureId && "bg-muted/40 ring-1 ring-sol-green ring-inset")}
                  key={f.featureId}
                  onClick={() => setParams(feature === f.featureId ? {} : { feature: f.featureId })}
                  type="button"
                >
                  <div className="truncate text-muted-foreground text-xs">{f.featureId}</div>
                  <div className="font-display font-semibold text-2xl tabular-nums">{compact(f.total)}</div>
                  <div className="text-[11px] text-muted-foreground">{f.events.toLocaleString()} events · 30 days</div>
                </button>
              ))}
            </div>
          )}
          <div className="grid border">
            <UsageChart days={30} u={data.daily} />
          </div>
          <Panel
            actions={
              feature ? (
                <Link className="text-muted-foreground text-xs hover:text-foreground" to="/dashboard/usage">
                  All features
                </Link>
              ) : undefined
            }
            title={feature ? `Events for ${feature}` : "Recent events"}
          >
            {data.events.length === 0 ? (
              <EmptyNote icon={<ChartLineUpIcon />} title="No usage yet" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="ps-5">When</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Feature</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="pe-5">Properties</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.events.map((e, i) => (
                      <TableRow key={e.id ?? i}>
                        <TableCell className="ps-5 text-muted-foreground">{dateTime(e.occurredAt)}</TableCell>
                        <TableCell>
                          <Link className="hover:text-sol-green" to={`/dashboard/customers/${encodeURIComponent(e.customerId)}`}>
                            {e.customerId}
                          </Link>
                        </TableCell>
                        <TableCell>{e.featureId}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(e.value)}</TableCell>
                        <TableCell className="max-w-80 truncate pe-5 font-mono text-muted-foreground text-xs">{e.properties ? JSON.stringify(e.properties) : ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
