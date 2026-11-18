import type { ReactNode } from "react";
import { Link } from "react-router";
import { Logo, LogoMark } from "@/components/brand";
import { StackArt } from "@/components/graphics";

/** Split screen: the form on paper, and a cobalt panel holding a spec card. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-10">
        <Link className="w-max" to="/">
          <Logo />
        </Link>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="font-medium text-4xl tracking-[-0.035em]">{title}</h1>
          {subtitle && <p className="mt-3 text-muted-foreground text-sm leading-relaxed">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-muted-foreground text-sm">{footer}</div>}
        </div>
        <p className="label-mono text-[10px] text-muted-foreground">Open source · Apache-2.0 · non-custodial</p>
      </div>
      <div className="grain relative hidden place-items-center bg-cobalt p-10 lg:grid xl:p-16">
        <div className="w-full max-w-xl bg-paper text-ink">
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <span className="flex items-center gap-2 font-semibold tracking-tight">
              <LogoMark className="size-4" />
              nummo
            </span>
            <span className="label-mono text-ink/60">SETTLEMENT · USDC</span>
          </div>
          <StackArt className="h-64 xl:h-72" />
          <div className="grid grid-cols-[auto_1fr] gap-6 p-5">
            <span className="label-mono pt-1 text-ink/60">How it pays</span>
            <p className="text-balance text-lg leading-snug tracking-tight">
              Usage billing that settles in seconds. Your customers approve once; renewals, overage and top-ups land straight in your wallet.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
