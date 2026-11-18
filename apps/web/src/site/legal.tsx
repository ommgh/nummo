import { useEffect, type ReactNode } from "react";
import { Link } from "react-router";
import { Logo } from "@/components/brand";
import { Footer } from "./landing";

/**
 * Terms of Service and Privacy Policy for the hosted service.
 *
 * Edit LEGAL before relying on these pages: who runs the service, how to reach
 * them, and whose law applies. They are a starting point written for an early,
 * free, non-custodial beta, not legal advice; have a lawyer read them before
 * taking payment for the service or onboarding customers at scale.
 */
const GITHUB = "https://github.com/ommgh/nummo";
export const LEGAL = {
  /** The person or company that runs the hosted service. */
  operator: "the nummo project",
  /** Where people reach the operator about these documents and their data. */
  contact: `${GITHUB}/issues`,
  contactLabel: "an issue on GitHub (or, for anything private, the email address in the repository's profile)",
  governingLaw: "India",
  effective: "18 November 2026",
};

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · nummo`;
    window.scrollTo(0, 0);
  }, [title]);
  return (
    <div className="min-h-svh bg-background font-sans">
      <header className="border-b">
        <div className="mx-auto flex max-w-[88rem] items-center justify-between px-4 py-4 md:px-6">
          <Link to="/">
            <Logo />
          </Link>
          <nav className="flex gap-5 text-muted-foreground text-sm">
            <Link className="hover:text-foreground" to="/terms">
              Terms
            </Link>
            <Link className="hover:text-foreground" to="/privacy">
              Privacy
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[88rem] px-5 py-16 md:px-10 md:py-24">
        <article className="mx-auto max-w-2xl">
          <p className="label-mono flex items-center gap-2 text-muted-foreground">
            <span className="size-2 bg-cobalt" />
            Effective {LEGAL.effective}
          </p>
          <h1 className="mt-5 font-medium text-4xl tracking-[-0.035em] md:text-6xl">{title}</h1>
          <div className="legal mt-10 grid gap-8 text-[15px] leading-7 [&_a]:underline [&_a]:underline-offset-4 [&_a:hover]:text-primary [&_h2]:mb-3 [&_h2]:font-medium [&_h2]:tracking-tight [&_h2]:text-foreground [&_h2]:text-xl [&_li]:mt-1.5 [&_p+p]:mt-3 [&_p]:text-muted-foreground [&_li]:text-muted-foreground [&_strong]:text-foreground [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
            {children}
          </div>
        </article>
      </main>
      <Footer />
    </div>
  );
}

const Contact = () => (
  <a href={LEGAL.contact} rel="noopener" target="_blank">
    {LEGAL.contactLabel}
  </a>
);

export function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <section>
        <p>
          These terms cover the hosted nummo service: the website, the dashboard, the API, the hosted checkout and customer portal, and the settlement worker run by {LEGAL.operator} ("we"). By creating an account or using the API you agree to them. If you
          use nummo for a company, you agree for that company.
        </p>
        <p>
          The nummo software is open source under the{" "}
          <a href={`${GITHUB}/blob/master/LICENSE`} rel="noopener" target="_blank">
            Apache License 2.0
          </a>
          . If you run it yourself, that licence governs your use of the code, and these terms do not apply.
        </p>
      </section>

      <section>
        <h2>1. What nummo is, and is not</h2>
        <p>
          nummo is billing software. It keeps a usage ledger and entitlements for your customers, and asks Solana's Subscriptions program to move stablecoins from your customers' wallets to <strong>your</strong> wallet within limits each customer approves on-chain.
        </p>
        <ul>
          <li>
            <strong>Non-custodial.</strong> Payments go straight from your customer's wallet to your merchant wallet. We never hold, pool or control your funds or your customers' funds, and cannot send them anywhere else.
          </li>
          <li>
            <strong>The puller key.</strong> The hosted service holds a "puller" key that submits collection transactions and pays network fees. The on-chain program only lets it pull into the merchant wallet named in each plan, and never more than the ceiling the customer approved per period.
          </li>
          <li>
            <strong>Not a bank, payment processor, exchange or money transmitter,</strong> and not financial, tax or legal advice. We do not convert currencies, offer refunds or chargebacks, or verify anyone's identity.
          </li>
        </ul>
      </section>

      <section>
        <h2>2. Beta service</h2>
        <p>
          The hosted service is an early beta. Test mode runs on Solana devnet, with tokens that have no value. Live mode, where offered, moves real stablecoins: start with small amounts. Features may change or be removed, and there is no uptime commitment. The service is free during the beta;
          if that changes we will give at least 30 days' notice before you are charged anything.
        </p>
      </section>

      <section>
        <h2>3. Your account and keys</h2>
        <ul>
          <li>Give accurate account details and keep your password, sessions and API keys secret. You are responsible for everything done with them.</li>
          <li>Your merchant wallet and its keys are yours alone. We never ask for a seed phrase or private key, and cannot recover a lost wallet.</li>
          <li>The plan ceiling you publish on-chain is permanent for that plan version. Check it before you publish.</li>
          <li>Tell us promptly if you think an account or key has been compromised.</li>
        </ul>
      </section>

      <section>
        <h2>4. Your responsibilities as a merchant</h2>
        <p>You are the seller to your customers. You are responsible for:</p>
        <ul>
          <li>your pricing, the terms you offer your customers, customer support, refunds and disputes;</li>
          <li>taxes on what you sell and receive, including any rules on digital assets where you or your customers are;</li>
          <li>complying with the laws that apply to your business, including sanctions, anti-money-laundering, consumer protection and data protection laws;</li>
          <li>having a lawful basis to send us your customers' data, and telling your customers how it is used.</li>
        </ul>
      </section>

      <section>
        <h2>5. Acceptable use</h2>
        <p>Do not use nummo to:</p>
        <ul>
          <li>sell anything illegal where you or your customers are, or take part in fraud, scams or deceptive billing;</li>
          <li>deal with sanctioned people, entities or regions, or evade sanctions;</li>
          <li>charge people who have not knowingly approved the payment;</li>
          <li>probe, overload or attack the service, get around rate limits, or access other merchants' data;</li>
          <li>resell the hosted service as your own without our written agreement (running the open-source code yourself is always fine).</li>
        </ul>
        <p>We may limit, suspend or close accounts that break these terms or put the service or other users at risk, with notice where we reasonably can.</p>
      </section>

      <section>
        <h2>6. Blockchain risks</h2>
        <p>Using public blockchains carries risks outside our control, which you accept:</p>
        <ul>
          <li>Confirmed transactions cannot be reversed by us or anyone else.</li>
          <li>Solana, its RPC providers, wallets or the Subscriptions program may be slow, unavailable, changed or faulty. The Subscriptions program is published by the Solana Foundation, not by us.</li>
          <li>Stablecoins can lose their peg or be frozen by their issuer.</li>
          <li>Network fees and prices change. Data written on-chain is public and permanent.</li>
        </ul>
      </section>

      <section>
        <h2>7. Your data</h2>
        <p>
          You own the data you send us. You let us store and process it to run the service for you, as described in the{" "}
          <Link to="/privacy">Privacy Policy</Link>. You can export it through the API, and ask us to delete your account at any time.
        </p>
      </section>

      <section>
        <h2>8. Disclaimer</h2>
        <p>
          The service is provided <strong>"as is" and "as available"</strong>, without warranties of any kind, express or implied, including fitness for a particular purpose, accuracy of billing results, and non-infringement, to the fullest extent the law allows.
          Check your billing records against the chain (<code>nummo verify</code> does this) before relying on them.
        </p>
      </section>

      <section>
        <h2>9. Limitation of liability</h2>
        <p>
          To the fullest extent the law allows, we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or digital assets, however caused. Our total liability for any claim about the service is limited
          to the greater of the fees you paid us in the 12 months before the claim and USD 100. Nothing here limits liability that cannot be limited by law.
        </p>
      </section>

      <section>
        <h2>10. Indemnity</h2>
        <p>You will cover our reasonable costs from claims by third parties (including your customers) that arise from your products, your pricing, your use of the service in breach of these terms, or your breach of the law.</p>
      </section>

      <section>
        <h2>11. Ending</h2>
        <p>
          You can stop using the service at any time, and ask us to delete your account. We may end the hosted service or your access with 30 days' notice, or sooner for a serious breach of these terms. On-chain subscriptions are records on Solana, not in our service: your customers
          can always cancel them from their own wallets, and you can keep collecting by self-hosting the open-source code.
        </p>
      </section>

      <section>
        <h2>12. Changes and law</h2>
        <p>
          We may update these terms. For material changes we will give notice on the site or by email at least 14 days before they apply; continuing to use the service after that means you accept them. These terms are governed by the laws of {LEGAL.governingLaw}.
        </p>
      </section>

      <section>
        <h2>13. Contact</h2>
        <p>
          Questions about these terms: <Contact />. Security problems: please report them privately through{" "}
          <a href={`${GITHUB}/security/advisories/new`} rel="noopener" target="_blank">
            GitHub security advisories
          </a>
          .
        </p>
      </section>
    </LegalPage>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <section>
        <p>
          This policy explains what personal data the hosted nummo service, run by {LEGAL.operator} ("we"), collects and what we do with it. If you self-host nummo, you run your own copy and we receive nothing.
        </p>
        <p>
          Short version: we collect what we need to run billing for you, we do not sell data, we do not use advertising or analytics trackers, and anything written to the Solana blockchain is public and permanent.
        </p>
      </section>

      <section>
        <h2>1. Two roles</h2>
        <ul>
          <li>
            <strong>Merchants</strong> (people with a nummo account): we decide how your account data is used, as described here.
          </li>
          <li>
            <strong>Your customers:</strong> when you send us data about your customers through the API, checkout or portal, we process it on your behalf and on your instructions. You decide what to send and you are responsible for telling your customers. If you are a
            merchant's customer, contact that merchant first.
          </li>
        </ul>
      </section>

      <section>
        <h2>2. What we collect</h2>
        <ul>
          <li>
            <strong>Account data:</strong> your name, email address, password (stored only as a salted hash), organization name and team memberships. If you sign in with GitHub or Google, the profile details they share (name, email, avatar).
          </li>
          <li>
            <strong>Sessions:</strong> a session cookie, plus the IP address and browser user agent of each signed-in session, for security.
          </li>
          <li>
            <strong>API keys:</strong> stored only as hashes; we cannot show a key again after it is created.
          </li>
          <li>
            <strong>Billing data you send:</strong> customer identifiers, and a name or email if you provide them; usage events and the properties you attach; plans, balances, invoices and payments; wallet addresses and transaction signatures; webhook endpoints.
          </li>
          <li>
            <strong>Agent payments:</strong> the paying wallet address and the payment transaction.
          </li>
          <li>
            <strong>Technical data:</strong> IP addresses and request details in server logs and in short-lived, in-memory rate-limit counters, to keep the service working and stop abuse.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. What we use it for</h2>
        <ul>
          <li>to provide the service: authenticate you, meter usage, settle payments, send webhooks and show your dashboard;</li>
          <li>to send service email, such as password reset links (no marketing email without your opt-in);</li>
          <li>to secure the service, prevent abuse and debug problems;</li>
          <li>to meet legal obligations.</li>
        </ul>
        <p>Where a legal basis is needed, it is performing our contract with you, our legitimate interest in running a secure service, or a legal obligation.</p>
      </section>

      <section>
        <h2>4. Cookies</h2>
        <p>
          We use only the cookies needed to keep you signed in (<code>nummo.*</code> session cookies). No advertising, analytics or cross-site tracking cookies. The checkout and portal store nothing about your wallet in cookies; your wallet extension may keep its own
          records.
        </p>
      </section>

      <section>
        <h2>5. Public blockchain data</h2>
        <p>
          Plans, subscriptions, payments and wallet addresses that reach Solana are public, visible to anyone, and cannot be changed or deleted by us or anyone else. Deleting your nummo account removes our copy, not the on-chain record.
        </p>
      </section>

      <section>
        <h2>6. Who we share it with</h2>
        <p>We do not sell personal data. We share it only with providers that help run the service, under their own security and privacy terms:</p>
        <ul>
          <li>
            <strong>Railway</strong>, which hosts the servers and database;
          </li>
          <li>
            <strong>our email provider</strong>, which delivers service email;
          </li>
          <li>
            <strong>Solana RPC providers</strong>, which receive the transactions we submit and the accounts we read;
          </li>
          <li>
            <strong>GitHub or Google</strong>, if you choose to sign in with them;
          </li>
          <li>
            <strong>your own webhook endpoints</strong>, which receive the events you subscribe to.
          </li>
        </ul>
        <p>We may also disclose data when the law requires it, or to protect the rights and safety of users and the service. These providers may process data outside your country.</p>
      </section>

      <section>
        <h2>7. How long we keep it</h2>
        <ul>
          <li>Account and billing data: while your account is open. When you ask us to delete it, we delete it within 30 days.</li>
          <li>Database backups: kept up to 30 days, then overwritten.</li>
          <li>Server logs: kept by our host for its standard retention period.</li>
          <li>Rate-limit counters: in memory only, for minutes.</li>
        </ul>
      </section>

      <section>
        <h2>8. Security</h2>
        <p>
          Traffic is encrypted with HTTPS. Passwords and API keys are stored as hashes. Your merchant wallet's key never reaches our servers. No system is perfectly secure: if a breach affects your personal data, we will tell you without undue delay.
        </p>
      </section>

      <section>
        <h2>9. Your rights</h2>
        <p>
          You can see and correct most of your data in the dashboard, and export billing data through the API. You can ask us for a copy, correction or deletion of your personal data, or object to how we use it, through <Contact />. Depending on where you live, you may also
          complain to your data protection authority.
        </p>
      </section>

      <section>
        <h2>10. Children</h2>
        <p>The service is for businesses and developers and is not meant for anyone under 18.</p>
      </section>

      <section>
        <h2>11. Changes</h2>
        <p>We will post changes here with a new effective date, and tell account holders by email about material ones before they apply.</p>
      </section>
    </LegalPage>
  );
}
