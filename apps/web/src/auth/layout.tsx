import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "react-router";
import { Logo } from "@/components/brand";

const Dither = lazy(() => import("@/components/Dither"));

/** Split screen: the form on the left, a dithered Solana-coloured wave on the right. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-10">
        <Link className="w-max" to="/">
          <Logo />
        </Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="font-display font-semibold text-3xl tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-muted-foreground text-sm">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-muted-foreground text-xs">{footer}</div>}
        </div>
        <p className="text-[11px] text-muted-foreground">Open source · Apache-2.0 · non-custodial</p>
      </div>
      <div className="relative hidden overflow-hidden border-l lg:block">
        <Suspense fallback={<div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgb(153_69_255/0.3),transparent_60%)]" />}>
          <div className="absolute inset-0">
            <Dither backgroundColor="#07070b" mouseRadius={0.35} palette={["#07070b", "#2a1452", "#9945FF", "#00C2FF", "#14F195"]} pixelSize={3} waveAmplitude={0.32} waveFrequency={2.6} waveSpeed={0.035} />
          </div>
        </Suspense>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent" />
        <div className="pointer-events-none absolute inset-x-10 bottom-12 space-y-4">
          <p className="font-display font-medium text-3xl leading-tight tracking-tight">
            Usage billing that <span className="text-gradient">settles in seconds</span>, straight to your wallet.
          </p>
          <p className="max-w-md text-muted-foreground text-sm">Subscriptions, credits and metered pricing on Solana stablecoins. Your customers approve once; nummo does the rest.</p>
        </div>
      </div>
    </div>
  );
}
