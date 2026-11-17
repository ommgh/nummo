import type * as React from "react";
import { Bar, BarChart, XAxis, YAxis } from "recharts";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Badge } from "@/components/ui/badge";
import { DashboardCard } from "@/components/dashboard-card";
import type { Overview } from "@/lib/types";
import { dayLabel, usdc } from "@/lib/format";

const chartConfig = { amount: { label: "USDC", color: "var(--chart-1)" } } satisfies ChartConfig;

function GradientBar(props: React.SVGProps<SVGRectElement> & { index?: number }) {
  const { fill, x = 0, y = 0, width = 0, height = 0, index = 0 } = props;
  const gid = `collected-bar-${index}`;
  return (
    <>
      <rect fill={`url(#${gid})`} height={height} stroke="none" width={width} x={x} y={y} />
      <rect fill={fill} height={Number(height) > 0 ? 2 : 0} stroke="none" width={width} x={x} y={y} />
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity={0.55} />
          <stop offset="100%" stopColor={fill} stopOpacity={0} />
        </linearGradient>
      </defs>
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
          <Badge className="border-none bg-sol-green/10 text-sol-green" variant="secondary">
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
          <BarChart accessibilityLayer data={rows} margin={{ left: 0, right: 0 }}>
            <XAxis axisLine={false} dataKey="day" interval={6} tickFormatter={(v) => dayLabel(String(v))} tickLine={false} tickMargin={10} />
            <YAxis hide domain={[0, (max: number) => Math.max(max, 1)]} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => dayLabel(String(p?.[0]?.payload?.day ?? ""))} />} cursor={false} />
            <Bar dataKey="amount" fill="var(--color-amount)" shape={<GradientBar />} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </DashboardCard>
  );
}
