import { Link } from "react-router";
import { ArrowRightIcon, CheckCircleIcon, CircleIcon } from "@phosphor-icons/react";
import { Dashboard } from "@/components/dashboard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/hooks/use-api";
import type { ApiKey, Overview, PlanVersion } from "@/lib/types";
import { useSession } from "@/dashboard/session";
import { ErrorNote, PageHeader } from "@/dashboard/ui";
import { cn } from "@/lib/utils";

export function OverviewPage() {
  const { session, env } = useSession();
  const { data, error, reload } = useApi<Overview>("/overview");
  const first = session.user.name.split(" ")[0];
  return (
    <>
      <PageHeader
        actions={
          <Button asChild variant="outline">
            <Link to="/dashboard/customers">
              Customers <ArrowRightIcon />
            </Link>
          </Button>
        }
        description={`${session.org?.name} · ${env === "live" ? "live, settling on mainnet" : "test, settling on devnet"}`}
        title={`Welcome back${first ? `, ${first}` : ""}`}
      />
      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !data ? (
        <div className="grid grid-cols-1 gap-px border bg-border md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div className="bg-background p-6" key={i}>
              <Skeleton className="h-20" />
            </div>
          ))}
          <div className="bg-background p-6 md:col-span-2 lg:col-span-4">
            <Skeleton className="h-72" />
          </div>
        </div>
      ) : (
        <>
          {data.customers === 0 && <GettingStarted />}
          <Dashboard o={data} />
        </>
      )}
    </>
  );
}

/** First-run checklist: a key, a pricing config, a published plan, a first customer. */
function GettingStarted() {
  const keys = useApi<{ keys: ApiKey[] }>("/keys");
  const plans = useApi<{ versions: PlanVersion[] }>("/plans");
  const { env } = useSession();
  const hasKey = !!keys.data?.keys.some((k) => k.env === env && !k.revokedAt);
  const hasPlans = !!plans.data?.versions.length;
  const published = !!plans.data?.versions.some((v) => v.published);
  const steps = [
    { done: hasKey, title: "Create an API key", body: "Your server calls nummo with a secret key.", to: "/dashboard/keys" },
    { done: hasPlans, title: "Push your pricing", body: "Define features and plans in nummo.config.ts, then run nummo push.", href: "https://github.com/ommgh/nummo/blob/master/docs/guide/pricing-config.md" },
    { done: published, title: "Publish paid plans on-chain", body: "Sign once with your merchant wallet; payments land in it directly.", to: "/dashboard/plans" },
    { done: false, title: "Charge your first customer", body: "attach() returns a checkout link; the customer signs with their wallet.", href: "https://github.com/ommgh/nummo/blob/master/docs/guide/quickstart.md" },
  ];
  return (
    <section className="relative mb-6 overflow-hidden border bg-card/40 p-5 md:p-6">
      <div aria-hidden className="pointer-events-none absolute -top-24 right-0 h-48 w-96 bg-sol-purple/15 blur-3xl" />
      <h2 className="font-display font-semibold text-lg">Get set up</h2>
      <p className="mb-5 text-muted-foreground text-sm">Four steps from zero to your first on-chain charge. About 30 minutes on devnet.</p>
      <ol className="grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => {
          const inner = (
            <>
              <div className="flex items-center gap-2 text-xs">
                {s.done ? <CheckCircleIcon className="size-4 text-sol-green" weight="fill" /> : <CircleIcon className="size-4 text-muted-foreground" />}
                <span className="text-muted-foreground">Step {i + 1}</span>
              </div>
              <p className={cn("font-medium text-sm", s.done && "text-muted-foreground line-through")}>{s.title}</p>
              <p className="text-muted-foreground text-xs leading-relaxed">{s.body}</p>
            </>
          );
          const cls = "flex h-full flex-col gap-2 bg-background p-4 transition-colors hover:bg-muted/30";
          return (
            <li key={s.title}>
              {s.to ? (
                <Link className={cls} to={s.to}>
                  {inner}
                </Link>
              ) : (
                <a className={cls} href={s.href} rel="noopener" target="_blank">
                  {inner}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
