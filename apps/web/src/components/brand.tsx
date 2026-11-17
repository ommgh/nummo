import type React from "react";
import { cn } from "@/lib/utils";

/** The nummo mark: a stack of three offset bars, Solana-gradient, like coins settling into a ledger. */
export function LogoMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn("size-6", className)} {...props}>
      <defs>
        <linearGradient id="nummo-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9945FF" />
          <stop offset="0.55" stopColor="#00C2FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <path d="M8 6h20l-4 5H4z" fill="url(#nummo-g)" />
      <path d="M4 13.5h20l4 5H8z" fill="url(#nummo-g)" opacity=".85" />
      <path d="M8 21h20l-4 5H4z" fill="url(#nummo-g)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display font-semibold text-lg tracking-tight", className)}>
      <LogoMark />
      nummo
    </span>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-svh place-items-center">
      <LogoMark className="size-8 animate-pulse" />
    </div>
  );
}
