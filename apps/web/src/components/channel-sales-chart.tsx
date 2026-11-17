import { useId } from "react";
import { CartesianGrid, Line, LineChart, XAxis } from "recharts";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { DashboardCard } from "@/components/dashboard-card";
import type { UsageDaily } from "@/lib/types";
import { dayLabel } from "@/lib/format";
import { EmptyNote } from "@/dashboard/ui";
import { ChartLineUpIcon } from "@phosphor-icons/react";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
/** Chart keys must be CSS-safe: feature ids can hold dots and dashes. */
const keyOf = (f: string) => `f_${f.replace(/[^a-zA-Z0-9_]/g, "_")}`;

/** Usage per feature per day: the dashboard-2 "channel sales" chart, fed by usage events. */
export function UsageChart({ u, days = 14 }: { u: UsageDaily; days?: number }) {
  const uid = useId().replace(/:/g, "");
  const glow = `usage-glow-${uid}`;
  const rows = u.series.slice(-days).map((r) => ({ day: r.day, ...Object.fromEntries(u.features.map((f) => [keyOf(f), Number(r.values[f] ?? 0)])) }));
  const config = Object.fromEntries(u.features.map((f, i) => [keyOf(f), { label: f, color: COLORS[i % COLORS.length] }])) satisfies ChartConfig;
  return (
    <DashboardCard className="gap-0 md:col-span-2">
      <CardHeader>
        <CardTitle>Usage</CardTitle>
        <CardDescription>Busiest features per day, last {days} days.</CardDescription>
      </CardHeader>
      <CardContent>
        {u.features.length === 0 ? (
          <EmptyNote icon={<ChartLineUpIcon />} title="No usage yet">
            Call <code className="text-foreground">track()</code> from your app and each event lands here.
          </EmptyNote>
        ) : (
          <ChartContainer className="aspect-auto h-60 w-full p-0 md:h-72" config={config}>
            <LineChart accessibilityLayer data={rows} margin={{ left: 12, right: 12, top: 8 }}>
              <CartesianGrid className="stroke-border" vertical={false} />
              <XAxis axisLine={false} dataKey="day" interval={2} tickFormatter={(v) => dayLabel(String(v))} tickLine={false} tickMargin={8} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => dayLabel(String(p?.[0]?.payload?.day ?? ""))} />} cursor={false} />
              <ChartLegend content={<ChartLegendContent />} />
              <defs>
                <filter height="140%" id={glow} width="140%" x="-20%" y="-20%">
                  <feGaussianBlur result="blur" stdDeviation="8" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>
              {u.features.map((f) => (
                <Line dataKey={keyOf(f)} dot={false} filter={`url(#${glow})`} key={f} stroke={`var(--color-${keyOf(f)})`} strokeWidth={2} type="step" />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </DashboardCard>
  );
}
