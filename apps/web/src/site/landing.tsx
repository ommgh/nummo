import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
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
import { Logo, LogoMark } from "@/components/brand";
import { cn } from "@/lib/utils";
import { CodeWindow } from "./code";

const Dither = lazy(() => import("@/components/Dither"));
const PixelBlast = lazy(() => import("@/components/PixelBlast"));
const PixelCard = lazy(() => import("@/components/PixelCard"));

const GITHUB = "https://github.com/ommgh/nummo";
const DOCS = `${GITHUB}/tree/master/docs/guide`;
const SOL_PALETTE = ["#07070b", "#1d0f3a", "#9945FF", "#00C2FF", "#14F195"];

export function Landing() {
  useEffect(() => {
    document.title = "nummo · usage billing on Solana";
  }, []);
  return (
    <div className="min-h-svh overflow-x-clip bg-background font-sans">
      <Nav />
      <main>
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

function Section({ id, eyebrow, title, intro, children, className }: { id?: string; eyebrow: string; title: ReactNode; intro?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("relative border-b", className)} id={id}>
      <div className="mx-auto max-w-6xl border-x px-5 py-20 md:px-10 md:py-28">
        <p className="mb-4 font-mono text-sol-green text-xs uppercase tracking-[0.2em]">// {eyebrow}</p>
        <h2 className="max-w-3xl text-balance font-display font-semibold text-3xl tracking-tight md:text-5xl">{title}</h2>
        {intro && <p className="mt-5 max-w-2xl text-pretty text-muted-foreground leading-relaxed">{intro}</p>}
        <div className="mt-12 md:mt-16">{children}</div>
      </div>
    </section>
  );
}

function Plus({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={cn("pointer-events-none absolute size-4 text-muted-foreground/60", className)} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path d="M5 12h14M12 5v14" strokeWidth="1.5" />
    </svg>
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
    <header className={cn("sticky top-0 z-50 border-b transition-colors", scrolled ? "bg-background/80 backdrop-blur-md" : "border-transparent bg-transparent")}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5 md:px-10">
        <Link aria-label="nummo home" to="/">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-7 text-muted-foreground text-sm md:flex">
          {links.map((l) => (
            <a className="transition-colors hover:text-foreground" href={l.href} key={l.href}>
              {l.label}
            </a>
          ))}
          <a className="transition-colors hover:text-foreground" href={DOCS} rel="noopener" target="_blank">
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
          <Button asChild>
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
        <div className="border-t bg-background px-5 py-4 md:hidden">
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
              <Button asChild>
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
    <section className="relative -mt-16 border-b">
      <div aria-hidden className="absolute inset-0 overflow-hidden">
        <Suspense fallback={null}>
          <div className="absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_80%_70%_at_50%_30%,black,transparent)]">
            <Dither backgroundColor="#07070b" mouseRadius={0.3} palette={SOL_PALETTE} pixelSize={3} waveAmplitude={0.28} waveFrequency={2.2} waveSpeed={0.03} />
          </div>
        </Suspense>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_45%,rgb(7_7_11/0.92),rgb(7_7_11/0.55)_60%,transparent)]" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
      </div>
      <div className="relative mx-auto max-w-6xl border-x px-5 pt-36 pb-20 md:px-10 md:pt-44 md:pb-28">
        <Plus className="-bottom-2 -left-2" />
        <Plus className="-right-2 -bottom-2" />
        <a
          className="group mx-auto mb-8 flex w-max items-center gap-2 border bg-background/60 px-3 py-1.5 text-xs backdrop-blur transition-colors hover:border-sol-green/50"
          href={`${GITHUB}/blob/master/docs/03-solana-settlement.md`}
          rel="noopener"
          target="_blank"
        >
          <span className="bg-sol-green px-1.5 py-0.5 font-semibold text-[10px] text-primary-foreground uppercase">New</span>
          Built on Solana's native Subscriptions program
          <ArrowRightIcon className="size-3 transition-transform group-hover:translate-x-0.5" />
        </a>
        <h1 className="mx-auto max-w-4xl text-balance text-center font-display font-semibold text-5xl leading-[1.02] tracking-tight md:text-7xl">
          Usage billing that <span className="text-gradient animate-shimmer">settles in seconds</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-pretty text-center text-lg text-muted-foreground leading-relaxed">
          Subscriptions, credits and metered pricing for AI and API startups, paid in USDC on Solana. Three API calls in your app; customers approve once in their wallet; money lands in yours.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button asChild className="h-11 px-5 text-sm" size="lg">
            <Link to="/sign-up">
              Start for free <ArrowRightIcon />
            </Link>
          </Button>
          <Button asChild className="h-11 px-5 text-sm" size="lg" variant="outline">
            <a href={`${DOCS}/quickstart.md`} rel="noopener" target="_blank">
              Read the quickstart
            </a>
          </Button>
        </div>
        <InstallLine />
        <div className="relative mx-auto mt-16 max-w-3xl">
          <div aria-hidden className="absolute -inset-px bg-gradient-to-r from-sol-purple/40 via-sol-blue/20 to-sol-green/40 blur-2xl" />
          <CodeWindow className="relative" tabs={HERO_CODE} />
        </div>
      </div>
    </section>
  );
}

function InstallLine() {
  const cmd = "git clone https://github.com/ommgh/nummo";
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="mx-auto mt-6 flex items-center gap-3 border border-dashed bg-background/50 px-4 py-2 font-mono text-muted-foreground text-xs backdrop-blur transition-colors hover:text-foreground"
      onClick={async () => {
        await navigator.clipboard.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      type="button"
    >
      <span className="text-sol-green">$</span> {cmd}
      {copied ? <CheckIcon className="size-3.5 text-sol-green" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

// ---------------------------------------------------------------- built on

function BuiltOn() {
  const items = ["Solana Subscriptions", "USDC", "Wallet Standard", "Phantom", "Solflare", "Backpack", "x402", "PostgreSQL", "TypeScript SDK", "Apache-2.0"];
  return (
    <section className="border-b">
      <div className="mx-auto flex max-w-6xl items-center gap-8 overflow-hidden border-x px-5 py-6 md:px-10">
        <p className="shrink-0 text-muted-foreground text-xs uppercase tracking-widest">Built on</p>
        <div className="relative flex-1 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_10%,black_90%,transparent)]">
          <div className="flex w-max animate-marquee gap-10">
            {[...items, ...items].map((t, i) => (
              <span className="flex items-center gap-2 whitespace-nowrap text-muted-foreground text-sm" key={i}>
                <LogoMark className="size-3.5 opacity-60" />
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- problem

function Problem() {
  const rows = [
    { icon: <HandCoinsIcon />, title: "Fees that eat micropayments", card: "2.9% + 30¢ per charge makes a 5¢ API call unbillable.", sol: "A pull costs a fraction of a cent, so you can settle small amounts often." },
    { icon: <TimerIcon />, title: "Money that arrives next week", card: "Card payouts take days, and chargebacks can claw them back for months.", sol: "USDC lands in your wallet when the transaction confirms, in seconds." },
    { icon: <GlobeHemisphereWestIcon />, title: "Customers you can't charge", card: "Plenty of developers and agents have no card that works on your checkout.", sol: "Anyone with a Solana wallet and USDC can pay, from any country." },
  ];
  return (
    <Section
      eyebrow="The problem"
      intro="Usage pricing is how AI products are sold now, but the payment rails underneath were built for monthly seat licences. So every startup ends up rebuilding balances, limits and retries on top of a card processor."
      title={
        <>
          Card rails weren't built for <span className="text-gradient">usage</span>.
        </>
      }
    >
      <div className="grid gap-px border bg-border md:grid-cols-3">
        {rows.map((r) => (
          <div className="flex flex-col gap-4 bg-background p-6 md:p-8" key={r.title}>
            <div className="grid size-10 place-items-center border text-sol-purple [&_svg]:size-5">{r.icon}</div>
            <h3 className="font-display font-medium text-lg">{r.title}</h3>
            <p className="flex gap-2 text-muted-foreground text-sm">
              <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              {r.card}
            </p>
            <p className="flex gap-2 text-sm">
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-sol-green" />
              {r.sol}
            </p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- how it works

function HowItWorks() {
  const steps = [
    {
      icon: <SignatureIcon />,
      title: "Your customer approves a ceiling, once",
      body: "At checkout they sign a Solana Subscriptions approval in their own wallet: up to 70 USDC every 30 days, say. They need USDC, not SOL: nummo pays the fees.",
    },
    {
      icon: <GaugeIcon />,
      title: "nummo meters, and pulls what's owed",
      body: "check() and track() keep balances in real time. Renewals, overage and auto top-ups are pulled within the signed ceiling, never above it, enforced on-chain.",
    },
    {
      icon: <WalletIcon />,
      title: "USDC lands in your wallet",
      body: "Every pull goes straight from the customer to the wallet that owns the plan. nummo never holds funds, and the puller key can only pay you.",
    },
  ];
  return (
    <Section
      className="bg-[radial-gradient(ellipse_50%_40%_at_80%_0%,rgb(153_69_255/0.08),transparent)]"
      eyebrow="How it works"
      id="how"
      intro="nummo is the stateful billing layer on top of Solana's Subscriptions and Allowances program. The chain holds the money and the consent; nummo holds the ledger."
      title="Approve once. Bill exactly. Settle on-chain."
    >
      <ol className="grid gap-px border bg-border lg:grid-cols-3">
        {steps.map((s, i) => (
          <li className="relative flex flex-col gap-4 bg-background p-6 md:p-8" key={s.title}>
            <div className="flex items-center justify-between">
              <div className="grid size-11 place-items-center bg-gradient-sol text-primary-foreground [&_svg]:size-5">{s.icon}</div>
              <span className="font-display font-semibold text-5xl text-muted/80">0{i + 1}</span>
            </div>
            <h3 className="font-display font-medium text-xl">{s.title}</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{s.body}</p>
          </li>
        ))}
      </ol>
      <FlowDiagram />
    </Section>
  );
}

/** Customer wallet → (signed ceiling) → Subscriptions program → (pull) → merchant wallet, with nummo beside it. */
function FlowDiagram() {
  return (
    <div className="mt-10 grid items-center gap-4 border bg-card/30 p-6 text-xs md:grid-cols-[1fr_auto_1.2fr_auto_1fr] md:p-8">
      <Node icon={<UsersThreeIcon />} sub="signs the ceiling once" title="Customer wallet" />
      <Arrow label="up to the ceiling" />
      <div className="relative border border-sol-purple/40 bg-sol-purple/5 p-4 text-center">
        <div className="mb-1 font-medium text-sm">Solana Subscriptions program</div>
        <div className="text-muted-foreground">enforces amount, period and destination</div>
        <div className="mt-3 border border-dashed px-3 py-2 text-muted-foreground">
          <span className="text-sol-green">nummo</span> ledger · meters usage · asks for the pull
        </div>
      </div>
      <Arrow label="USDC" />
      <Node accent icon={<WalletIcon />} sub="owns the plan" title="Your wallet" />
    </div>
  );
}

function Node({ icon, title, sub, accent }: { icon: ReactNode; title: string; sub: string; accent?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3 border p-4", accent && "border-sol-green/40 bg-sol-green/5")}>
      <div className={cn("grid size-9 shrink-0 place-items-center border [&_svg]:size-4", accent ? "text-sol-green" : "text-sol-purple")}>{icon}</div>
      <div>
        <div className="font-medium text-sm">{title}</div>
        <div className="text-muted-foreground">{sub}</div>
      </div>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-muted-foreground md:flex-col">
      <span className="text-[10px] uppercase tracking-wider">{label}</span>
      <span className="relative h-px w-16 overflow-hidden bg-border md:w-20">
        <span className="absolute inset-y-0 left-0 w-1/2 animate-[marquee_1.6s_linear_infinite] bg-gradient-to-r from-transparent via-sol-green to-transparent" />
      </span>
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
    { icon: <TerminalWindowIcon />, title: "Pricing as code", body: "Features, plans, credits and overage in one TypeScript file. nummo push applies it; versions keep existing customers on their terms." },
    { icon: <LightningIcon />, title: "check() before, track() after", body: "One call to gate a feature, one to record what was used. Idempotent, and fast enough for the hot path." },
    { icon: <ReceiptIcon />, title: "attach() for everything paid", body: "New plans, upgrades with proration, scheduled downgrades and top-ups all return a checkout link or settle straight away." },
  ];
  return (
    <Section
      eyebrow="The developer experience"
      intro="Your billing logic moves out of your codebase and into a config file. Change prices without a deploy, and stop writing webhook handlers for card edge cases."
      title={
        <>
          Your pricing in one file.
          <br className="hidden md:block" /> Three calls in your app.
        </>
      }
    >
      <div className="grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
        <ul className="grid content-start gap-8">
          {bullets.map((b) => (
            <li className="flex gap-4" key={b.title}>
              <div className="grid size-10 shrink-0 place-items-center border text-sol-green [&_svg]:size-5">{b.icon}</div>
              <div>
                <h3 className="font-display font-medium text-lg">{b.title}</h3>
                <p className="mt-1 text-muted-foreground text-sm leading-relaxed">{b.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <CodeWindow tabs={[{ name: "nummo.config.ts", code: CONFIG_CODE }, ...HERO_CODE]} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- pricing models

function PricingModels() {
  const models = [
    { icon: <ArrowsClockwiseIcon />, title: "Subscriptions", body: "Flat fees on any period, in hours or days. Renewed by pull, no card on file.", colors: "#9945FF,#7b3fe4,#c9a8ff" },
    { icon: <ChartLineUpIcon />, title: "Usage-based", body: "Pay as you go per call, token or minute. Overage is pulled once it reaches your threshold.", colors: "#00C2FF,#0a8fd6,#9be7ff" },
    { icon: <CoinsIcon />, title: "Credits", body: "One balance many features draw from, at different rates. Perfect for AI models.", colors: "#14F195,#0fbf77,#a6ffd8" },
    { icon: <PlusCircleIcon />, title: "Top-ups", body: "One-off credit packs, or automatic refills when a balance runs low, within a cap.", colors: "#DC1FFF,#9945FF,#f2a6ff" },
    { icon: <StackIcon />, title: "Hybrid plans", body: "Base fee plus included usage plus metered overage, with a spend cap per period.", colors: "#9945FF,#00C2FF,#14F195" },
    { icon: <CubeIcon />, title: "Free tiers & add-ons", body: "A default free plan for everyone, and add-ons that stack on top of the main plan.", colors: "#19FB9B,#00C2FF,#ffffff" },
  ];
  return (
    <Section
      className="bg-[radial-gradient(ellipse_50%_40%_at_10%_100%,rgb(20_241_149/0.06),transparent)]"
      eyebrow="Pricing models"
      id="models"
      intro="Whatever you sell, it fits in a plan. Upgrades are prorated and charged now; downgrades wait for the period to end. All of it enforced by the ceiling your customer signed."
      title={
        <>
          Any pricing model. <span className="text-gradient">Seriously.</span>
        </>
      }
    >
      <div className="grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {models.map((m) => (
          <Suspense fallback={<ModelBody {...m} />} key={m.title}>
            <PixelCard className="h-full w-full place-items-stretch rounded-none bg-background shadow-none" colors={m.colors} gap={7} intro={false} opacity={0.55} radius={0} speed={35} theme="dark">
              <ModelBody {...m} />
            </PixelCard>
          </Suspense>
        ))}
      </div>
    </Section>
  );
}

function ModelBody({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="relative z-10 flex h-full min-h-52 flex-col gap-3 p-6 md:p-8">
      <div className="grid size-10 place-items-center border bg-background/80 text-foreground [&_svg]:size-5">{icon}</div>
      <h3 className="mt-auto font-display font-medium text-xl">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
    </div>
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
  return (
    <Section
      eyebrow="Features"
      id="features"
      intro="The parts every usage-priced product needs, done once, properly, and open source."
      title="Everything you need for AI and usage billing."
    >
      <div className="grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => (
          <div className="group relative flex flex-col gap-3 bg-background p-6 transition-colors hover:bg-card" key={f.title}>
            <div className="grid size-9 place-items-center border text-sol-purple transition-colors group-hover:border-sol-green/50 group-hover:text-sol-green [&_svg]:size-4">{f.icon}</div>
            <h3 className="font-display font-medium">{f.title}</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
      <DashboardPreview />
    </Section>
  );
}

/** A static picture of the dashboard, drawn in HTML so it stays sharp and on-brand. */
function DashboardPreview() {
  const bars = [3, 5, 4, 6, 5, 8, 7, 9, 6, 10, 9, 12, 11, 14, 12, 15, 13, 17, 16, 19];
  return (
    <div className="relative mt-14">
      <div aria-hidden className="absolute -inset-8 bg-[radial-gradient(ellipse_at_center,rgb(153_69_255/0.18),transparent_70%)] blur-2xl" />
      <div className="relative overflow-hidden border bg-background shadow-2xl">
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-muted" />
          <span className="size-2.5 rounded-full bg-muted" />
          <span className="size-2.5 rounded-full bg-muted" />
          <span className="ml-3 text-[11px] text-muted-foreground">Dashboard · Overview (illustration)</span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
          {[
            ["Customers", "1,284"],
            ["Paid subscribers", "312"],
            ["Run rate, 30 days", "9.4K"],
            ["Collected, 30 days", "11.2K"],
          ].map(([k, v]) => (
            <div className="bg-background p-4" key={k}>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{k}</div>
              <div className="mt-2 font-display font-semibold text-2xl tabular-nums">{v}</div>
            </div>
          ))}
          <div className="col-span-2 bg-background p-4 md:col-span-4">
            <div className="mb-3 flex items-center gap-2 text-sm">
              Collected <span className="bg-sol-green/10 px-1.5 text-sol-green text-xs">11,204 USDC</span>
            </div>
            <div className="flex h-32 items-end gap-1.5">
              {bars.map((h, i) => (
                <div className="flex-1 border-sol-green border-t-2 bg-gradient-to-b from-sol-green/50 to-transparent" key={i} style={{ height: `${(h / 19) * 100}%` }} />
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
    <section className="border-b">
      <div className="mx-auto grid max-w-6xl gap-px border-x bg-border sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div className="bg-background p-8" key={s.label}>
            <div className="text-gradient font-display font-semibold text-4xl tracking-tight md:text-5xl">{s.value}</div>
            <div className="mt-3 font-medium text-sm">{s.label}</div>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">{s.body}</p>
          </div>
        ))}
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
    <Section eyebrow="FAQ" id="faq" title="Questions, answered.">
      <Accordion className="border-t" collapsible type="single">
        {items.map((it) => (
          <AccordionItem key={it.q} value={it.q}>
            <AccordionTrigger className="py-5 text-left font-display text-base hover:no-underline md:text-lg">{it.q}</AccordionTrigger>
            <AccordionContent className="max-w-3xl pb-6 text-muted-foreground text-sm leading-relaxed">{it.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Section>
  );
}

// ---------------------------------------------------------------- final CTA and footer

function FinalCta() {
  return (
    <section className="relative overflow-hidden border-b">
      <Suspense fallback={null}>
        <div aria-hidden className="absolute inset-0 opacity-60">
          <PixelBlast accentColor="#14F195" color="#9945FF" edgeFade={0.3} enableRipples patternDensity={1.1} patternScale={2.5} pixelSize={4} speed={0.5} transparent variant="square" />
        </div>
      </Suspense>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_60%_at_50%_50%,rgb(7_7_11/0.92),rgb(7_7_11/0.4))]" />
      <div className="relative mx-auto max-w-6xl border-x px-5 py-28 text-center md:px-10 md:py-36">
        <h2 className="mx-auto max-w-3xl text-balance font-display font-semibold text-4xl tracking-tight md:text-6xl">
          Start billing in <span className="text-gradient">USDC</span> today.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-muted-foreground">Free and open source. Build the whole flow on devnet first: no real money, no card, no wallet needed to sign up.</p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button asChild className="h-11 px-5" size="lg">
            <Link to="/sign-up">
              Create your account <ArrowRightIcon />
            </Link>
          </Button>
          <Button asChild className="h-11 px-5" size="lg" variant="outline">
            <a href={GITHUB} rel="noopener" target="_blank">
              <GithubLogoIcon /> Star on GitHub
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const cols = [
    { title: "Product", links: [["How it works", "#how"], ["Pricing models", "#models"], ["Features", "#features"], ["Dashboard", "/dashboard"]] },
    { title: "Developers", links: [["Quickstart", `${DOCS}/quickstart.md`], ["Pricing config", `${DOCS}/pricing-config.md`], ["Billing flows", `${DOCS}/billing-flows.md`], ["Self-hosting", `${DOCS}/deploy.md`]] },
    { title: "Project", links: [["GitHub", GITHUB], ["Settlement design", `${GITHUB}/blob/master/docs/03-solana-settlement.md`], ["Licence (Apache-2.0)", `${GITHUB}/blob/master/LICENSE`]] },
  ];
  return (
    <footer>
      <div className="mx-auto grid max-w-6xl gap-10 border-x px-5 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)] md:px-10">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-muted-foreground text-xs leading-relaxed">Open-source usage billing for AI and API startups, settled in USDC on Solana.</p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h3 className="mb-3 text-muted-foreground text-xs uppercase tracking-widest">{c.title}</h3>
            <ul className="grid gap-2 text-sm">
              {c.links.map(([label, href]) => (
                <li key={label}>
                  {href!.startsWith("/") ? (
                    <Link className="hover:text-sol-green" to={href!}>
                      {label}
                    </Link>
                  ) : (
                    <a className="hover:text-sol-green" href={href} rel={href!.startsWith("http") ? "noopener" : undefined} target={href!.startsWith("http") ? "_blank" : undefined}>
                      {label}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 border-x px-5 py-5 text-[11px] text-muted-foreground md:px-10">
          <span>© {new Date().getFullYear()} nummo. Open source under Apache-2.0.</span>
          <span>Non-custodial software. Not financial or legal advice.</span>
        </div>
      </div>
    </footer>
  );
}
