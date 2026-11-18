import type * as React from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Badge } from "@/components/ui/badge";
import { DashboardCard } from "@/components/dashboard-card";
import type { Overview } from "@/lib/types";
import { dayLabel, usdc } from "@/lib/format";

const chartConfig = { amount: { label: "USDC", color: "var(--chart-1)" } } satisfies ChartConfig;

/** A flat bar with a marigold cap. */
function CappedBar(props: React.SVGProps<SVGRectElement>) {
  const { fill, x = 0, y = 0, width = 0, height = 0 } = props;
  return (
    <>
      <rect fill={fill} height={height} stroke="none" width={width} x={x} y={y} />
      {Number(height) > 0 && <rect fill="var(--color-marigold)" height={Math.min(3, Number(height))} stroke="none" width={width} x={x} y={y} />}
    </>
  );
}

export function NetRevenueChart({ o }: { o: Overview }) {
  const rows = o.daily.map((d) => ({ day: d.day, amount: Number(d.amount) }));
  return (
    <DashboardCard className="gap-0 md:col-span-2">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Collected</CardTitle>
          <Badge className="border-none bg-cobalt text-white" variant="secondary">
            {usdc(o.collected30d)} USDC
          </Badge>
        </div>
        <CardDescription>USDC pulled into your wallet per day, last 30 days.</CardDescription>
      </CardHeader>
      <CardContent className="relative">
        {Number(o.collected30d) === 0 && (
          <p className="absolute inset-0 z-10 grid place-items-center text-muted-foreground text-xs">No payments in the last 30 days</p>
        )}
        <ChartContainer className="aspect-auto h-60 w-full md:h-72" config={chartConfig}>
          <BarChart accessibilityLayer data={rows} margin={{ left: 12, right: 12 }}>
            <XAxis axisLine={false} dataKey="day" interval={6} tickFormatter={(v) => dayLabel(String(v))} tickLine={false} tickMargin={10} />
            <YAxis hide domain={[0, (max: number) => Math.max(max, 1)]} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => dayLabel(String(p?.[0]?.payload?.day ?? ""))} />} cursor={false} />
            <Bar dataKey="amount" fill="var(--color-amount)" shape={<CappedBar />} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </DashboardCard>
  );
}
