import { useId } from "react";
import type React from "react";
import { cn } from "@/lib/utils";

export const PALETTE = {
  ink: "#1b1a19",
  paper: "#f2efe9",
  cobalt: "#1764ff",
  tangerine: "#ff5a1f",
  marigold: "#ffae0a",
  iris: "#9b6dff",
  moss: "#4d6a3a",
  lime: "#a9cf45",
} as const;

/**
 * The nummo mark: a coin cut into four bands of the signal colours, like
 * balances stacked in a ledger. Reads at 16px; no gradients.
 */
export function LogoMark({ className, ...props }: React.ComponentProps<"svg">) {
  const id = `nummo-coin-${useId().replace(/:/g, "")}`;
  return (
    <svg aria-hidden="true" className={cn("size-6", className)} fill="none" viewBox="0 0 32 32" {...props}>
      <clipPath id={id}>
        <circle cx="16" cy="16" r="14" />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        <rect fill={PALETTE.cobalt} height="6.25" width="32" y="2" />
        <rect fill={PALETTE.tangerine} height="6.25" width="32" y="9.25" />
        <rect fill={PALETTE.marigold} height="6.25" width="32" y="16.5" />
        <rect fill={PALETTE.iris} height="6.25" width="32" y="23.75" />
      </g>
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-sans font-semibold text-[1.35rem] leading-none tracking-[-0.04em]", className)}>
      <LogoMark className="size-[1.1em]" />
      nummo
    </span>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-svh place-items-center">
      <LogoMark className="size-8 animate-spin [animation-duration:1.6s]" />
    </div>
  );
}
