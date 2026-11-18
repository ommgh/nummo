import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  ChartLineUpIcon,
  CheckIcon,
  CoinsIcon,
  CopyIcon,
  CreditCardIcon,
  CubeIcon,
  GaugeIcon,
  GithubLogoIcon,
  GlobeHemisphereWestIcon,
  HandCoinsIcon,
  LightningIcon,
  ListIcon,
  LockKeyIcon,
  PlusCircleIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  SignatureIcon,
  StackIcon,
  TerminalWindowIcon,
  TimerIcon,
  UsersThreeIcon,
  WalletIcon,
  WebhooksLogoIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Logo, LogoMark, PALETTE } from "@/components/brand";
import { ConvergeArt, HeroArt, ProcessArt, StackArt } from "@/components/graphics";
import { cn } from "@/lib/utils";
import { CodeWindow } from "./code";

const GITHUB = "https://github.com/ommgh/nummo";
const DOCS = `${GITHUB}/tree/master/docs/guide`;

export function Landing() {
  useEffect(() => {
    document.title = "nummo · usage billing on Solana";
  }, []);
  return (
    <div className="min-h-svh overflow-x-clip bg-background font-sans">
      <Nav />
      <main className="mx-auto grid max-w-[88rem] gap-3 px-3 pb-3 md:gap-4 md:px-4 md:pb-4">
        <Hero />
        <BuiltOn />
        <Problem />
        <HowItWorks />
        <ThreeCalls />
        <PricingModels />
        <Features />
        <Numbers />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------- layout helpers

/** The mono "tag" voice: a coloured square and an uppercase label. */
export function Eyebrow({ children, color = "bg-tangerine", className }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <p className={cn("label-mono flex items-center gap-2 text-muted-foreground", className)}>
      <span className={cn("size-2", color)} />
      {children}
    </p>
  );
}

function Tile({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={cn("relative overflow-hidden bg-background text-foreground", className)} id={id}>
      {children}
    </section>
  );
}

function SectionHead({ eyebrow, title, intro, color, className }: { eyebrow: string; title: ReactNode; intro?: ReactNode; color?: string; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-6 md:grid-cols-[1fr_minmax(0,26rem)] md:items-end", className)}>
      <div>
        <Eyebrow color={color}>{eyebrow}</Eyebrow>
        <h2 className="mt-5 max-w-3xl text-balance font-medium text-4xl leading-[1.02] tracking-[-0.035em] md:text-6xl">{title}</h2>
      </div>
      {intro && <p className="text-pretty text-muted-foreground leading-relaxed">{intro}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- nav

function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 8);
    f();
    window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  const links = [
    { href: "#how", label: "How it works" },
    { href: "#models", label: "Pricing models" },
    { href: "#features", label: "Features" },
    { href: "#faq", label: "FAQ" },
  ];
  return (
    <header className={cn("sticky top-0 z-50 transition-colors", scrolled ? "border-b bg-background/90 backdrop-blur-md" : "border-transparent border-b bg-background")}>
      <div className="mx-auto flex h-16 max-w-[88rem] items-center justify-between gap-6 px-4 md:px-6">
        <Link aria-label="nummo home" to="/">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {links.map((l) => (
            <a className="rounded-full px-3 py-1.5 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground" href={l.href} key={l.href}>
              {l.label}
            </a>
          ))}
          <a className="rounded-full px-3 py-1.5 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground" href={DOCS} rel="noopener" target="_blank">
            Docs
          </a>
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <Button asChild size="icon" variant="ghost">
            <a aria-label="GitHub" href={GITHUB} rel="noopener" target="_blank">
              <GithubLogoIcon />
            </a>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/sign-in">Sign in</Link>
          </Button>
          <Button asChild variant="contrast">
            <Link to="/sign-up">
              Start for free <ArrowRightIcon />
            </Link>
          </Button>
        </div>
        <Button aria-label="Menu" className="md:hidden" onClick={() => setOpen(!open)} size="icon" variant="ghost">
          {open ? <XIcon /> : <ListIcon />}
        </Button>
      </div>
      {open && (
        <div className="border-t bg-background px-4 py-4 md:hidden">
          <nav className="grid gap-1 text-sm">
            {links.map((l) => (
              <a className="py-2 text-muted-foreground" href={l.href} key={l.href} onClick={() => setOpen(false)}>
                {l.label}
              </a>
            ))}
            <a className="py-2 text-muted-foreground" href={DOCS}>
              Docs
            </a>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button asChild variant="outline">
                <Link to="/sign-in">Sign in</Link>
              </Button>
              <Button asChild variant="contrast">
                <Link to="/sign-up">Start free</Link>
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- hero

const HERO_CODE = [
  {
    name: "check.ts",
    code: `// Can this customer use the feature right now?
const { allowed, balance } = await nummo.check({
  customerId: "user_123",
  featureId: "premium_message",
});

if (!allowed) return showUpgrade();`,
  },
  {
    name: "track.ts",
    code: `// Record usage. Credits are deducted in real time,
// overage is pulled in USDC once it adds up.
await nummo.track({
  customerId: "user_123",
  featureId: "premium_message",
  value: 1,
});`,
  },
  {
    name: "attach.ts",
    code: `// Put a customer on a plan. Paid plans return a
// checkout link: they approve a ceiling once, in their wallet.
const { checkoutUrl } = await nummo.attach({
  customerId: "user_123",
  planId: "pro",
});`,
  },
];

function Hero() {
  return (
    <Tile className="dark grain grain-soft">
      <div className="relative">
        <HeroArt className="h-[300px] sm:h-[380px] md:h-[460px]" />
        <a
          className="label-mono absolute top-5 left-5 flex items-center gap-2 border border-foreground/40 bg-background/80 px-2.5 py-1.5 text-foreground backdrop-blur transition-colors hover:border-marigold hover:text-marigold md:top-7 md:left-8"
          href={`${GITHUB}/blob/master/docs/03-solana-settlement.md`}
          rel="noopener"
          target="_blank"
        >
          <span className="bg-marigold px-1 text-ink">New</span>
          Solana Subscriptions program
          <ArrowRightIcon className="size-3" />
        </a>
      </div>
      <div className="grid grid-cols-1 gap-10 px-5 pt-2 pb-8 md:grid-cols-[1.4fr_1fr] md:items-end md:px-8 md:pb-10">
        <div>
          <h1 className="max-w-4xl text-balance font-medium text-[2.75rem] leading-[0.98] tracking-[-0.045em] sm:text-6xl md:text-[5.25rem]">Usage billing that settles in seconds.</h1>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link to="/sign-up">
                Start for free <ArrowRightIcon />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href={`${DOCS}/quickstart.md`} rel="noopener" target="_blank">
                Read the quickstart
              </a>
            </Button>
          </div>
        </div>
        <div className="space-y-5">
          <p className="text-pretty text-foreground/75 leading-relaxed md:text-lg">
            Subscriptions, credits and metered pricing for AI and API startups, paid in USDC on Solana. Three API calls in your app; customers approve once in their wallet; money lands in yours.
          </p>
          <InstallLine />
        </div>
      </div>
    </Tile>
  );
}

function InstallLine() {
  const cmd = "git clone https://github.com/ommgh/nummo";
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="flex w-full items-center gap-3 border border-foreground/25 border-dashed px-4 py-2.5 text-left font-mono text-foreground/70 text-xs transition-colors hover:border-foreground/60 hover:text-foreground"
      onClick={async () => {
        await navigator.clipboard.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      type="button"
    >
      <span className="text-marigold">$</span>
      <span className="flex-1 truncate">{cmd}</span>
      {copied ? <CheckIcon className="size-3.5 text-lime" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

// ---------------------------------------------------------------- built on

function BuiltOn() {
  const items = ["Solana Subscriptions", "USDC", "Wallet Standard", "Phantom", "Solflare", "Backpack", "x402", "PostgreSQL", "TypeScript SDK", "Apache-2.0"];
  return (
    <div className="flex items-center gap-8 overflow-hidden border-y py-4">
      <p className="label-mono shrink-0 pl-1 text-muted-foreground">Built on</p>
      <div className="relative flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
        <div className="flex w-max animate-marquee gap-12">
          {[...items, ...items].map((t, i) => (
            <span className="label-mono flex items-center gap-2.5 whitespace-nowrap text-foreground/70" key={i}>
              <LogoMark className="size-3" />
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- problem

function Problem() {
  const rows = [
    { icon: <HandCoinsIcon />, color: "bg-cobalt text-white", title: "Fees that eat micropayments", card: "2.9% + 30¢ per charge makes a 5¢ API call unbillable.", sol: "A pull costs a fraction of a cent, so you can settle small amounts often." },
    { icon: <TimerIcon />, color: "bg-tangerine text-ink", title: "Money that arrives next week", card: "Card payouts take days, and chargebacks can claw them back for months.", sol: "USDC lands in your wallet when the transaction confirms, in seconds." },
    { icon: <GlobeHemisphereWestIcon />, color: "bg-marigold text-ink", title: "Customers you can't charge", card: "Plenty of developers and agents have no card that works on your checkout.", sol: "Anyone with a Solana wallet and USDC can pay, from any country." },
  ];
  return (
    <Tile className="px-5 py-16 md:px-8 md:py-24">
      <SectionHead
        eyebrow="01 / The problem"
        intro="Usage pricing is how AI products are sold now, but the payment rails underneath were built for monthly seat licences. So every startup ends up rebuilding balances, limits and retries on top of a card processor."
        title="Card rails weren't built for usage."
      />
      <div className="mt-14 grid gap-3 md:grid-cols-3">
        {rows.map((r, i) => (
          <div className="flex flex-col border bg-card" key={r.title}>
            <div className={cn("grain flex items-center justify-between px-5 py-4 [&_svg]:size-6", r.color)}>
              {r.icon}
              <span className="label-mono opacity-80">0{i + 1}</span>
            </div>
            <div className="flex flex-1 flex-col gap-4 p-5 md:p-6">
              <h3 className="font-medium text-xl tracking-tight">{r.title}</h3>
              <p className="flex gap-2.5 text-muted-foreground text-sm leading-relaxed">
                <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                {r.card}
              </p>
              <p className="flex gap-2.5 text-sm leading-relaxed">
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
                {r.sol}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Tile>
  );
}

// ---------------------------------------------------------------- how it works

function HowItWorks() {
  const steps = [
    {
      icon: <SignatureIcon />,
      color: PALETTE.cobalt,
      label: "01 APPROVE",
      title: "Your customer approves a ceiling, once",
      body: "At checkout they sign a Solana Subscriptions approval in their own wallet: up to 70 USDC every 30 days, say. They need USDC, not SOL: nummo pays the fees.",
    },
    {
      icon: <GaugeIcon />,
      color: PALETTE.iris,
      label: "02 METER",
      title: "nummo meters, and pulls what's owed",
      body: "check() and track() keep balances in real time. Renewals, overage and auto top-ups are pulled within the signed ceiling, never above it, enforced on-chain.",
    },
    {
      icon: <WalletIcon />,
      color: PALETTE.marigold,
      label: "03 SETTLE",
      title: "USDC lands in your wallet",
      body: "Every pull goes straight from the customer to the wallet that owns the plan. nummo never holds funds, and the puller key can only pay you.",
    },
  ];
  return (
    <Tile className="dark grain grain-soft px-5 py-16 md:px-8 md:py-24" id="how">
      <SectionHead
        color="bg-iris"
        eyebrow="02 / How it works"
        intro="nummo is the stateful billing layer on top of Solana's Subscriptions and Allowances program. The chain holds the money and the consent; nummo holds the ledger."
        title="Approve once. Bill exactly. Settle on-chain."
      />
      <div className="-mx-5 mt-10 overflow-x-auto px-5 md:mx-0 md:overflow-visible md:px-0">
        <ProcessArt className="min-w-[720px] md:min-w-0" steps={steps} />
      </div>
      <ol className="mt-6 grid gap-px border bg-border lg:grid-cols-3">
        {steps.map((s) => (
          <li className="flex flex-col gap-4 bg-background p-6 md:p-8" key={s.title}>
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center text-ink [&_svg]:size-5" style={{ background: s.color }}>
                {s.icon}
              </span>
              <span className="label-mono text-muted-foreground">{s.label}</span>
            </div>
            <h3 className="font-medium text-xl tracking-tight">{s.title}</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{s.body}</p>
          </li>
        ))}
      </ol>
      <FlowDiagram />
    </Tile>
  );
}

/** Customer wallet → (signed ceiling) → Subscriptions program → (pull) → merchant wallet, with nummo beside it. */
function FlowDiagram() {
  return (
    <div className="mt-3 grid items-stretch gap-3 text-xs md:grid-cols-[1fr_auto_1.3fr_auto_1fr]">
      <Node icon={<UsersThreeIcon />} sub="signs the ceiling once" tag="WALLET.CUSTOMER" title="Customer wallet" />
      <Arrow label="up to the ceiling" />
      <div className="flex flex-col justify-center gap-3 bg-paper p-5 text-ink">
        <span className="label-mono text-ink/60">PROGRAM.SUBSCRIPTIONS</span>
        <div className="font-medium text-base">Solana Subscriptions program</div>
        <div className="text-ink/70">enforces amount, period and destination</div>
        <div className="flex items-center gap-2 border border-ink/30 border-dashed px-3 py-2 text-ink/80">
          <LogoMark className="size-3.5" />
          nummo ledger · meters usage · asks for the pull
        </div>
      </div>
      <Arrow label="USDC" />
      <Node accent icon={<WalletIcon />} sub="owns the plan" tag="WALLET.MERCHANT" title="Your wallet" />
    </div>
  );
}

function Node({ icon, title, sub, tag, accent }: { icon: ReactNode; title: string; sub: string; tag: string; accent?: boolean }) {
  return (
    <div className={cn("flex flex-col justify-center gap-3 border p-5", accent && "grain border-transparent bg-cobalt text-white")}>
      <span className={cn("label-mono", accent ? "text-white/70" : "text-muted-foreground")}>{tag}</span>
      <div className="flex items-center gap-3">
        <div className={cn("grid size-9 shrink-0 place-items-center border [&_svg]:size-4", accent ? "border-white/40" : "text-marigold")}>{icon}</div>
        <div>
          <div className="font-medium text-sm">{title}</div>
          <div className={accent ? "text-white/75" : "text-muted-foreground"}>{sub}</div>
        </div>
      </div>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-1 text-muted-foreground md:flex-col">
      <span className="label-mono text-[10px]">{label}</span>
      <svg className="h-3 w-12 rotate-90 md:w-16 md:rotate-0" fill="none" viewBox="0 0 64 12">
        <line className="animate-flow" stroke="currentColor" strokeDasharray="4 4" x1="0" x2="58" y1="6" y2="6" />
        <path d="M56 1l6 5-6 5" stroke="currentColor" />
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- three calls

const CONFIG_CODE = `import { defineConfig, feature, plan, usdc } from "@usenummo/config";

const credits = feature({
  id: "credits",
  type: "credit_system",
  rates: [
    { feature: "basic_message", credits: 1 },
    { feature: "premium_message", credits: 10 },
  ],
});

export default defineConfig({
  features: [credits],
  plans: [
    plan({
      id: "pro",
      version: 1,
      name: "Pro",
      price: { amount: usdc("20"), period: "30d" },
      items: [{
        feature: "credits",
        included: 1000,
        reset: "period",
        overage: { price: usdc("0.01"), per: 1, cap: usdc("50") },
      }],
    }),
  ],
});`;

function ThreeCalls() {
  const bullets = [
    { icon: <TerminalWindowIcon />, color: "bg-cobalt text-white", title: "Pricing as code", body: "Features, plans, credits and overage in one TypeScript file. nummo push applies it; versions keep existing customers on their terms." },
    { icon: <LightningIcon />, color: "bg-marigold text-ink", title: "check() before, track() after", body: "One call to gate a feature, one to record what was used. Idempotent, and fast enough for the hot path." },
    { icon: <ReceiptIcon />, color: "bg-tangerine text-ink", title: "attach() for everything paid", body: "New plans, upgrades with proration, scheduled downgrades and top-ups all return a checkout link or settle straight away." },
  ];
  return (
    <Tile className="px-5 py-16 md:px-8 md:py-24">
      <SectionHead
        color="bg-cobalt"
        eyebrow="03 / Developer experience"
        intro="Your billing logic moves out of your codebase and into a config file. Change prices without a deploy, and stop writing webhook handlers for card edge cases."
        title="Your pricing in one file. Three calls in your app."
      />
      <div className="mt-14 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-14">
        <ul className="grid content-start gap-px self-start border bg-border">
          {bullets.map((b) => (
            <li className="flex gap-4 bg-background p-5" key={b.title}>
              <div className={cn("grain grid size-10 shrink-0 place-items-center [&_svg]:size-5", b.color)}>{b.icon}</div>
              <div>
                <h3 className="font-medium text-lg tracking-tight">{b.title}</h3>
                <p className="mt-1 text-muted-foreground text-sm leading-relaxed">{b.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <CodeWindow tabs={[{ name: "nummo.config.ts", code: CONFIG_CODE }, ...HERO_CODE]} />
      </div>
    </Tile>
  );
}

// ---------------------------------------------------------------- pricing models

function PricingModels() {
  const models = [
    { icon: <ArrowsClockwiseIcon />, title: "Subscriptions", body: "Flat fees on any period, in hours or days. Renewed by pull, no card on file.", cls: "bg-cobalt text-white", sub: "text-white/80" },
    { icon: <ChartLineUpIcon />, title: "Usage-based", body: "Pay as you go per call, token or minute. Overage is pulled once it reaches your threshold.", cls: "bg-tangerine text-ink", sub: "text-ink/75" },
    { icon: <CoinsIcon />, title: "Credits", body: "One balance many features draw from, at different rates. Perfect for AI models.", cls: "bg-marigold text-ink", sub: "text-ink/75" },
    { icon: <PlusCircleIcon />, title: "Top-ups", body: "One-off credit packs, or automatic refills when a balance runs low, within a cap.", cls: "bg-iris text-ink", sub: "text-ink/75" },
    { icon: <StackIcon />, title: "Hybrid plans", body: "Base fee plus included usage plus metered overage, with a spend cap per period.", cls: "bg-moss text-paper", sub: "text-paper/80" },
    { icon: <CubeIcon />, title: "Free tiers & add-ons", body: "A default free plan for everyone, and add-ons that stack on top of the main plan.", cls: "dark bg-background text-foreground", sub: "text-muted-foreground" },
  ];
  return (
    <Tile className="px-5 py-16 md:px-8 md:py-24" id="models">
      <SectionHead
        color="bg-marigold"
        eyebrow="04 / Pricing models"
        intro="Whatever you sell, it fits in a plan. Upgrades are prorated and charged now; downgrades wait for the period to end. All of it enforced by the ceiling your customer signed."
        title="Any pricing model. Seriously."
      />
      <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {models.map((m, i) => (
          <div className={cn("grain group flex min-h-64 flex-col gap-3 p-6 md:p-7", m.cls)} key={m.title}>
            <div className="flex items-start justify-between">
              <span className="label-mono opacity-70">0{i + 1}</span>
              <span className="grid size-12 place-items-center rounded-full border border-current/40 transition-transform duration-300 group-hover:rotate-12 [&_svg]:size-6">{m.icon}</span>
            </div>
            <h3 className="mt-auto font-medium text-2xl tracking-tight">{m.title}</h3>
            <p className={cn("text-sm leading-relaxed", m.sub)}>{m.body}</p>
          </div>
        ))}
      </div>
    </Tile>
  );
}

// ---------------------------------------------------------------- features

function Features() {
  const features = [
    { icon: <GaugeIcon />, title: "Real-time balances", body: "Included, granted and topped-up balances stacked per feature, deducted soonest-expiring first." },
    { icon: <ArrowsClockwiseIcon />, title: "Plan changes", body: "Prorated upgrades charged now, downgrades scheduled for the period end. Old versions are grandfathered." },
    { icon: <CreditCardIcon />, title: "Hosted checkout", body: "A page that connects Phantom, Solflare or Backpack, checks the USDC balance and asks for one signature." },
    { icon: <UsersThreeIcon />, title: "Customer portal", body: "Customers see their plan and balances, buy top-ups, switch plans and cancel or resume from their wallet." },
    { icon: <WebhooksLogoIcon />, title: "Webhooks", body: "Subscriptions, payments and failures pushed to your server, signed, with retries and a delivery log." },
    { icon: <ShieldCheckIcon />, title: "Reconciled with the chain", body: "nummo verify compares every plan and subscription with on-chain state and flags any drift." },
    { icon: <LockKeyIcon />, title: "Non-custodial", body: "Payments go from customer to merchant. The puller can only pay your wallet, up to what was signed." },
    { icon: <TerminalWindowIcon />, title: "CLI and SDK", body: "Typed TypeScript SDK, a CLI for config, plans and wallets, and test and live environments like Stripe." },
  ];
  const swatch = ["bg-cobalt", "bg-tangerine", "bg-marigold", "bg-iris", "bg-moss", "bg-cobalt", "bg-tangerine", "bg-marigold"];
  return (
    <Tile className="px-5 py-16 md:px-8 md:py-24" id="features">
      <SectionHead
        color="bg-iris"
        eyebrow="05 / Features"
        intro="The parts every usage-priced product needs, done once, properly, and open source."
        title="Everything you need for AI and usage billing."
      />
      <div className="mt-14 grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f, i) => (
          <div className="group relative flex flex-col gap-3 bg-background p-6 transition-colors hover:bg-card" key={f.title}>
            <div className="flex items-center justify-between">
              <div className="relative grid size-10 place-items-center border bg-background [&_svg]:size-5">
                <span className={cn("absolute -top-1 -right-1 size-2.5 transition-transform group-hover:scale-150", swatch[i])} />
                {f.icon}
              </div>
              <span className="label-mono text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
            </div>
            <h3 className="mt-3 font-medium text-lg tracking-tight">{f.title}</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
      <DashboardPreview />
    </Tile>
  );
}

/** A static picture of the dashboard, drawn in HTML so it stays sharp and on-brand. */
function DashboardPreview() {
  const bars = [3, 5, 4, 6, 5, 8, 7, 9, 6, 10, 9, 12, 11, 14, 12, 15, 13, 17, 16, 19];
  const nav = ["Overview", "Customers", "Plans", "Payments", "Usage"];
  return (
    <div className="mt-10 border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="label-mono text-muted-foreground">DASHBOARD.OVERVIEW · ILLUSTRATION</span>
        <span className="flex gap-1.5">
          <span className="size-2.5 bg-tangerine" />
          <span className="size-2.5 bg-marigold" />
          <span className="size-2.5 bg-cobalt" />
        </span>
      </div>
      <div className="grid md:grid-cols-[200px_1fr]">
        <div className="dark hidden flex-col gap-1 bg-sidebar p-3 text-sidebar-foreground md:flex">
          <span className="mb-3 flex items-center gap-2 px-2 pt-1 font-semibold text-sm tracking-tight">
            <LogoMark className="size-4" /> nummo
          </span>
          {nav.map((n, i) => (
            <span className={cn("flex items-center gap-2 px-2 py-1.5 text-xs", i === 0 ? "bg-sidebar-accent text-foreground" : "text-muted-foreground")} key={n}>
              <span className={cn("size-1.5", i === 0 ? "bg-cobalt" : "bg-muted-foreground/40")} />
              {n}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
          {[
            ["Customers", "1,284", "bg-cobalt"],
            ["Paid subscribers", "312", "bg-tangerine"],
            ["Run rate, 30 days", "9.4K", "bg-marigold"],
            ["Collected, 30 days", "11.2K", "bg-iris"],
          ].map(([k, v, c]) => (
            <div className="bg-background p-4" key={k}>
              <div className="label-mono flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className={cn("size-1.5", c)} />
                {k}
              </div>
              <div className="mt-3 font-medium text-3xl tabular-nums tracking-tight">{v}</div>
            </div>
          ))}
          <div className="col-span-2 bg-background p-4 md:col-span-4">
            <div className="mb-4 flex items-center gap-2 text-sm">
              Collected <span className="label-mono rounded-full bg-cobalt px-2 py-0.5 text-[10px] text-white">11,204 USDC</span>
            </div>
            <div className="flex h-36 items-end gap-1.5">
              {bars.map((h, i) => (
                <div className={cn("flex-1", i === bars.length - 1 ? "bg-tangerine" : "bg-cobalt")} key={i} style={{ height: `${(h / 19) * 100}%` }} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- numbers

function Numbers() {
  const stats = [
    { value: "< 1¢", label: "Fee per pull", body: "Solana transaction fees, paid by nummo's puller, not your customer." },
    { value: "Seconds", label: "To settle", body: "A pull is final once confirmed. No payout schedule, no reserve." },
    { value: "0", label: "Funds held", body: "Customer to merchant, directly. nummo is software, not a custodian." },
    { value: "100%", label: "Open source", body: "Apache-2.0. Self-host it, read it, change it." },
  ];
  return (
    <section className="grain bg-cobalt p-3 sm:p-8 md:p-16 lg:p-24">
      <div className="mx-auto max-w-5xl bg-paper text-ink">
        <StackArt className="h-44 md:h-64" width={1200} />
        <div className="grid gap-px bg-ink/15 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <div className="bg-paper p-6" key={s.label}>
              <div className="label-mono text-ink/60">{s.label}</div>
              <div className="mt-3 font-medium text-4xl tracking-[-0.04em]">{s.value}</div>
              <p className="mt-2 text-ink/70 text-xs leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- FAQ

function Faq() {
  const items = [
    {
      q: "Do my customers need SOL, or a crypto background?",
      a: "They need a Solana wallet with USDC in it, nothing else. nummo's puller pays the network fees and the rent for their subscription record, so the wallet never needs SOL. The checkout shows the price, the period and the most that can ever be charged before they sign.",
    },
    {
      q: "Does nummo ever hold my money?",
      a: "No. Every payment moves from the customer's wallet to the wallet that owns your plan, in one transaction. The puller key on the server can only send funds to your wallet, and only up to the ceiling each customer signed.",
    },
    {
      q: "How is this different from Stripe Billing, Orb or Autumn?",
      a: "Those sit on card rails. nummo does the same job (entitlements, metering, credits, plan changes) but settles in USDC on Solana: fees small enough for micropayments, money in your wallet in seconds, no chargebacks, and customers anywhere in the world.",
    },
    {
      q: "What happens if a payment fails?",
      a: "The subscription goes past due and nummo retries on a schedule you set (1h, 6h, 24h, 72h by default), sending a webhook each time. If the last retry fails, the plan ends and the customer falls back to your free plan.",
    },
    {
      q: "Can I self-host it?",
      a: "Yes. nummo is two Node processes and a Postgres database, with a Dockerfile. The hosted version and a self-hosted one run the same code.",
    },
    {
      q: "Which networks and stablecoins?",
      a: "USDC on Solana mainnet for live keys, and devnet USDC for test keys, so you can build the whole flow without real money. Other stablecoins are on the roadmap.",
    },
  ];
  return (
    <Tile className="grid grid-cols-1 gap-10 px-5 py-16 md:grid-cols-[1fr_1.6fr] md:px-8 md:py-24" id="faq">
      <div>
        <Eyebrow color="bg-moss">06 / FAQ</Eyebrow>
        <h2 className="mt-5 text-balance font-medium text-4xl leading-[1.02] tracking-[-0.035em] md:text-6xl">Questions, answered.</h2>
      </div>
      <Accordion className="border-t" collapsible type="single">
        {items.map((it, i) => (
          <AccordionItem key={it.q} value={it.q}>
            <AccordionTrigger className="gap-4 py-5 text-left text-base hover:no-underline md:text-lg">
              <span className="flex gap-4">
                <span className="label-mono mt-1.5 text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                {it.q}
              </span>
            </AccordionTrigger>
            <AccordionContent className="max-w-3xl pb-6 pl-10 text-muted-foreground text-sm leading-relaxed">{it.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Tile>
  );
}

// ---------------------------------------------------------------- final CTA and footer

function FinalCta() {
  return (
    <Tile className="dark grain grain-soft">
      <ConvergeArt className="h-48 md:h-72" />
      <div className="px-5 pt-4 pb-14 text-center md:px-8 md:pb-20">
        <h2 className="mx-auto max-w-3xl text-balance font-medium text-4xl leading-[1] tracking-[-0.04em] md:text-7xl">Start billing in USDC today.</h2>
        <p className="mx-auto mt-5 max-w-xl text-foreground/70">Free and open source. Build the whole flow on devnet first: no real money, no card, no wallet needed to sign up.</p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg" variant="contrast">
            <Link to="/sign-up">
              Create your account <ArrowRightIcon />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href={GITHUB} rel="noopener" target="_blank">
              <GithubLogoIcon /> Star on GitHub
            </a>
          </Button>
        </div>
      </div>
    </Tile>
  );
}

export function Footer() {
  const cols = [
    { title: "Product", links: [["How it works", "/#how"], ["Pricing models", "/#models"], ["Features", "/#features"], ["Dashboard", "/dashboard"]] },
    { title: "Developers", links: [["Quickstart", `${DOCS}/quickstart.md`], ["Pricing config", `${DOCS}/pricing-config.md`], ["Billing flows", `${DOCS}/billing-flows.md`], ["Self-hosting", `${DOCS}/deploy.md`]] },
    { title: "Project", links: [["GitHub", GITHUB], ["Settlement design", `${GITHUB}/blob/master/docs/03-solana-settlement.md`], ["Licence (Apache-2.0)", `${GITHUB}/blob/master/LICENSE`], ["Terms of Service", "/terms"], ["Privacy Policy", "/privacy"]] },
  ];
  return (
    <footer className="mx-auto max-w-[88rem] px-3 pb-6 md:px-4">
      <div className="grid gap-10 border-t px-2 pt-12 pb-10 md:grid-cols-[1.6fr_repeat(3,1fr)] md:px-4">
        <div className="space-y-4">
          <Logo />
          <p className="max-w-xs text-muted-foreground text-sm leading-relaxed">Open-source usage billing for AI and API startups, settled in USDC on Solana.</p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h3 className="label-mono mb-4 text-muted-foreground">{c.title}</h3>
            <ul className="grid gap-2.5 text-sm">
              {c.links.map(([label, href]) => (
                <li key={label}>
                  {href!.startsWith("/") && !href!.startsWith("/#") ? (
                    <Link className="underline-offset-4 hover:underline" to={href!}>
                      {label}
                    </Link>
                  ) : (
                    <a className="underline-offset-4 hover:underline" href={href} rel={href!.startsWith("http") ? "noopener" : undefined} target={href!.startsWith("http") ? "_blank" : undefined}>
                      {label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="label-mono flex flex-wrap items-center justify-between gap-3 border-t px-2 pt-5 text-[10px] text-muted-foreground md:px-4">
        <span>© {new Date().getFullYear()} nummo · Apache-2.0</span>
        <span>Non-custodial software. Not financial or legal advice.</span>
      </div>
    </footer>
  );
}
