import type React from "react";
import { cn } from "@/lib/utils";
import { PALETTE as P } from "@/components/brand";

/**
 * Illustration primitives for the nummo look: flat colour beams, wire fans and
 * isometric coins. All plain SVG, so they stay sharp, cost nothing to load and
 * take the page's grain on top.
 */

type Pt = [number, number];

// ---------------------------------------------------------------- primitives

/** Contiguous triangular beams from `origin` to consecutive points on an edge. */
export function Beams({ origin, edge, colors, opacity = 1 }: { origin: Pt; edge: Pt[]; colors: string[]; opacity?: number }) {
  return (
    <g opacity={opacity}>
      {edge.slice(0, -1).map((p, i) => {
        const q = edge[i + 1]!;
        return <polygon fill={colors[i % colors.length]} key={i} points={`${origin[0]},${origin[1]} ${p[0]},${p[1]} ${q[0]},${q[1]}`} />;
      })}
    </g>
  );
}

/** Evenly spaced points along a straight edge. */
export function edgePoints(a: Pt, b: Pt, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
}

/** A cheap deterministic "random" in [0, 1), so drawings render the same everywhere. */
function rand(seed: number) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

/** Holes and studs on a coin's face, like a perforated token. */
function CoinDots({ cx, cy, rx, ry, seed, stroke, fill, density = 1 }: { cx: number; cy: number; rx: number; ry: number; seed: number; stroke: string; fill: string; density?: number }) {
  const dots: React.ReactNode[] = [];
  const cols = Math.max(2, Math.round(3 * density));
  const rows = Math.max(2, Math.round(2 * density));
  const r = Math.max(2, rx / (cols * 3.2));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = -0.62 + (1.24 * (i + (j % 2) * 0.5)) / cols;
      const v = -0.5 + (1 * (j + 0.5)) / rows;
      if (u * u + v * v > 0.5) continue;
      const k = seed * 31 + j * 7 + i;
      const solid = rand(k) > 0.55;
      dots.push(<ellipse cx={cx + u * rx} cy={cy + v * ry * 1.1} fill={solid ? fill : "none"} key={k} rx={r} ry={r * (ry / rx)} stroke={stroke} strokeWidth={1.2} />);
    }
  }
  return <>{dots}</>;
}

/** One coin in isometric view: a top ellipse over a short cylinder side. */
export function IsoCoin({
  cx,
  cy,
  rx,
  ry = rx * 0.5,
  h = rx * 0.32,
  top,
  side,
  stroke,
  dots = true,
  dotColor,
  seed = 1,
  density = 1,
}: {
  cx: number;
  cy: number;
  rx: number;
  ry?: number;
  h?: number;
  top: string;
  side?: string;
  stroke: string;
  dots?: boolean;
  dotColor?: string;
  seed?: number;
  density?: number;
}) {
  return (
    <g strokeLinejoin="round">
      <path d={`M${cx - rx},${cy} v${h} a${rx},${ry} 0 0 0 ${2 * rx},0 v${-h} Z`} fill={side ?? top} stroke={stroke} strokeWidth={1.4} />
      {side === undefined && <path d={`M${cx - rx},${cy} v${h} a${rx},${ry} 0 0 0 ${2 * rx},0 v${-h} Z`} fill="#000" opacity={0.22} />}
      <ellipse cx={cx} cy={cy} fill={top} rx={rx} ry={ry} stroke={stroke} strokeWidth={1.4} />
      {dots && <CoinDots cx={cx} cy={cy} density={density} fill={dotColor ?? stroke} rx={rx} ry={ry} seed={seed} stroke={dotColor ?? stroke} />}
    </g>
  );
}

/** A tag in the mono voice: an outlined box with a short uppercase label. */
export function SvgTag({ x, y, text, color, bg, anchor = "start" }: { x: number; y: number; text: string; color: string; bg?: string; anchor?: "start" | "middle" | "end" }) {
  const w = text.length * 7.4 + 14;
  const left = anchor === "start" ? x : anchor === "middle" ? x - w / 2 : x - w;
  return (
    <g>
      <rect fill={bg ?? "none"} height={20} stroke={color} strokeWidth={1} width={w} x={left} y={y - 14} />
      <text fill={color} fontFamily="Geist Mono Variable, ui-monospace, monospace" fontSize={11} letterSpacing="0.06em" x={left + 7} y={y}>
        {text}
      </text>
    </g>
  );
}

function MonoText({ x, y, children, color, size = 12, anchor = "start" }: { x: number; y: number; children: React.ReactNode; color: string; size?: number; anchor?: "start" | "middle" | "end" }) {
  return (
    <text fill={color} fontFamily="Geist Mono Variable, ui-monospace, monospace" fontSize={size} letterSpacing="0.08em" textAnchor={anchor} x={x} y={y}>
      {children}
    </text>
  );
}

// ---------------------------------------------------------------- compositions

/**
 * The hero: usage events on thin wires converge into one coin, and leave it as
 * flat beams of colour, settled money, fanning out to the right.
 */
export function HeroArt({ className }: { className?: string }) {
  const node: Pt = [600, 250];
  const beams = edgePoints([1240, -60], [1240, 560], 7);
  const events: { p: Pt; r: number; seed: number; label?: string }[] = [
    { p: [492, 212], r: 9, seed: 1 },
    { p: [430, 292], r: 12, seed: 2 },
    { p: [372, 170], r: 15, seed: 3, label: "track()" },
    { p: [300, 330], r: 20, seed: 4 },
    { p: [232, 112], r: 25, seed: 5 },
    { p: [170, 420], r: 32, seed: 6, label: "evt_0918" },
    { p: [96, 214], r: 38, seed: 7 },
  ];
  return (
    <svg aria-hidden className={cn("h-auto w-full", className)} fill="none" preserveAspectRatio="xMidYMid slice" viewBox="0 0 1200 500">
      <Beams colors={[P.cobalt, P.moss, P.tangerine, P.iris, P.tangerine, P.moss, P.cobalt]} edge={beams} origin={node} />
      {events.map((e) => {
        // Extend each wire past its coin to the left edge.
        const dx = e.p[0] - node[0];
        const dy = e.p[1] - node[1];
        const t = (0 - node[0]) / dx;
        return <line key={e.seed} stroke={P.paper} strokeOpacity={0.55} strokeWidth={1} x1={node[0]} x2={0} y1={node[1]} y2={node[1] + dy * t} />;
      })}
      <line className="animate-flow" stroke={P.marigold} strokeDasharray="4 8" strokeWidth={2} x1={node[0]} x2={0} y1={node[1]} y2={node[1] + ((214 - 250) * (0 - 600)) / (96 - 600)} />
      {events.map((e) => (
        <IsoCoin cx={e.p[0]} cy={e.p[1]} density={e.r > 24 ? 1.4 : 1} dotColor={P.paper} key={e.seed} rx={e.r} seed={e.seed} side={P.ink} stroke={P.paper} top={P.ink} />
      ))}
      {events
        .filter((e) => e.label)
        .map((e) => (
          <SvgTag color={P.paper} key={e.seed} text={e.label!} x={e.p[0] - e.r} y={e.p[1] - e.r * 0.5 - 14} />
        ))}
      <circle cx={node[0]} cy={node[1]} fill={P.paper} r={30} />
      <circle cx={node[0]} cy={node[1]} r={20} stroke={P.ink} strokeWidth={1.5} />
      <circle cx={node[0]} cy={node[1]} fill={P.ink} r={4} />
      <SvgTag bg={P.ink} color={P.paper} text="USDC → YOUR WALLET" x={1180} y={474} anchor="end" />
    </svg>
  );
}

/** How it works: a chain of coins with three lit steps, each pinned with a label. */
export function ProcessArt({ className, steps }: { className?: string; steps: { label: string; color: string }[] }) {
  const n = 11;
  const a: Pt = [40, 380];
  const b: Pt = [1180, 120];
  const lit = new Map([
    [2, 0],
    [5, 1],
    [8, 2],
  ]);
  const coins = Array.from({ length: n }, (_, i) => ({ i, x: a[0] + ((b[0] - a[0]) * i) / (n - 1), y: a[1] + ((b[1] - a[1]) * i) / (n - 1) }));
  const rx = 58;
  const ry = 27;
  return (
    <svg aria-hidden className={cn("h-auto w-full", className)} fill="none" viewBox="0 -30 1220 500">
      {/* Back to front: the top-right coins are furthest away. */}
      {[...coins].reverse().map((c) => {
        const s = lit.get(c.i);
        const color = s === undefined ? undefined : steps[s]?.color;
        return (
          <IsoCoin
            cx={c.x}
            cy={c.y + (color ? -10 : 0)}
            density={1.3}
            dotColor={color ? P.ink : P.paper}
            h={color ? 30 : 20}
            key={c.i}
            rx={rx}
            ry={ry}
            seed={c.i + 3}
            side={color ? undefined : P.ink}
            stroke={P.paper}
            top={color ?? P.ink}
          />
        );
      })}
      {coins
        .filter((c) => lit.has(c.i))
        .map((c) => {
          const s = lit.get(c.i)!;
          const step = steps[s]!;
          const up = s !== 1;
          const pin: Pt = [c.x + (up ? -10 : 20), up ? c.y - 150 : c.y + 140];
          const y = c.y - 10;
          const targets: Pt[] = up
            ? [
                [c.x - rx * 0.8, y - ry * 0.3],
                [c.x - rx * 0.25, y - ry * 0.85],
                [c.x + rx * 0.35, y - ry * 0.75],
                [c.x + rx * 0.85, y - ry * 0.2],
              ]
            : [
                [c.x - rx * 0.9, y + 30],
                [c.x - rx * 0.3, y + 30 + ry * 0.9],
                [c.x + rx * 0.4, y + 30 + ry * 0.85],
                [c.x + rx * 0.95, y + 30],
              ];
          return (
            <g key={c.i}>
              {targets.map((t, k) => (
                <line key={k} stroke={P.paper} strokeWidth={1} x1={pin[0]} x2={t[0]} y1={pin[1]} y2={t[1]} />
              ))}
              <circle cx={pin[0]} cy={pin[1]} fill={step.color} r={6} />
              <MonoText anchor="middle" color={P.paper} size={14} x={pin[0]} y={up ? pin[1] - 18 : pin[1] + 30}>
                {step.label}
              </MonoText>
            </g>
          );
        })}
    </svg>
  );
}

/** Payments arriving as beams from the left, landing on a stack of coins. */
export function StackArt({ className, bg = P.marigold, width = 600 }: { className?: string; bg?: string; width?: number }) {
  const stack: Pt = [width - 200, 210];
  const layers = [P.ink, P.cobalt, P.paper, P.tangerine, P.iris];
  return (
    <svg aria-hidden className={cn("h-auto w-full", className)} fill="none" preserveAspectRatio="xMidYMid slice" viewBox={`0 0 ${width} 320`}>
      <rect fill={bg} height="320" width={width} />
      <Beams colors={[P.iris, P.tangerine, P.cobalt, P.tangerine, P.iris]} edge={edgePoints([-20, 40], [-20, 340], 5)} origin={[stack[0] - 40, stack[1] + 20]} />
      <polygon fill={P.ink} points={`${stack[0]},${stack[1] - 40} ${width + 40},40 ${width + 40},360 ${stack[0]},${stack[1] + 80}`} />
      {layers.map((c, i) => (
        <IsoCoin
          cx={stack[0]}
          cy={stack[1] + 60 - i * 26}
          dots={i === layers.length - 1}
          dotColor={P.ink}
          h={24}
          key={i}
          rx={78}
          ry={34}
          seed={i + 11}
          side={c === P.paper ? "#d9d4ca" : undefined}
          stroke={P.ink}
          top={c}
        />
      ))}
    </svg>
  );
}

/** Two fans meeting in one coin: the closing call to action. */
export function ConvergeArt({ className }: { className?: string }) {
  const c: Pt = [600, 200];
  return (
    <svg aria-hidden className={cn("h-auto w-full", className)} fill="none" preserveAspectRatio="xMidYMid slice" viewBox="0 0 1200 400">
      <Beams colors={[P.cobalt, P.marigold, P.tangerine, P.iris, P.moss]} edge={edgePoints([-40, -20], [-40, 420], 5)} origin={c} />
      <Beams colors={[P.moss, P.iris, P.tangerine, P.marigold, P.cobalt]} edge={edgePoints([1240, -20], [1240, 420], 5)} origin={c} />
      <circle cx={c[0]} cy={c[1]} fill={P.paper} r={26} />
      <circle cx={c[0]} cy={c[1]} r={16} stroke={P.ink} strokeWidth={1.5} />
    </svg>
  );
}

/** A small decorative glyph: three stacked coins, for empty states and cards. */
export function CoinGlyph({ className, colors = [P.cobalt, P.tangerine, P.marigold], stroke = "currentColor" }: { className?: string; colors?: string[]; stroke?: string }) {
  return (
    <svg aria-hidden className={cn("size-12", className)} fill="none" viewBox="0 0 64 64">
      {colors.map((c, i) => (
        <IsoCoin cx={32} cy={44 - i * 11} dots={false} h={8} key={i} rx={22} ry={10} stroke={stroke} top={c} />
      ))}
    </svg>
  );
}
