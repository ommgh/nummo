// Response shapes of the dashboard API (apps/api/src/dashboard.ts). Amounts are decimal strings in USDC.

export type Env = "test" | "live";

export type Settlement = { network: string; mint: string; puller: string } | null;

export type Session = {
  user: { id: string; name: string; email: string; image: string | null };
  org: { id: string; name: string; slug: string; role: string } | null;
  env: Env;
  settlement: Settlement;
  publicUrl: string;
};

export type Payment = {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  invoiceId: string;
  kind: string;
  amount: string;
  signature: string;
  status: string;
  /** "x402" or "mpp" for a request paid on the spot (M4). */
  protocol: string | null;
  wallet: string | null;
  createdAt: string;
};

export type WebhookEvent = {
  id: string;
  type: string;
  createdAt: string;
  state: "delivered" | "dead" | "retrying" | "pending";
  attempts: number;
  lastError: string | null;
  payload: unknown;
};

export type Overview = {
  customers: number;
  paidSubscribers: number;
  pastDue: number;
  canceling: number;
  runRate30d: string;
  collected30d: string;
  payments30d: number;
  daily: { day: string; amount: string }[];
  usage: { featureId: string; total: string; events: number }[];
  webhooks: { pending: number; failing: number; dead: number };
  webhookEndpoint: string | null;
  recentPayments: Payment[];
  agentPayments30d: { amount: string; count: number; wallets: number };
  activity: { type: string; createdAt: string; state: string; payload: unknown }[];
  usageDaily: UsageDaily;
};

export type UsageDaily = { features: string[]; series: { day: string; values: Record<string, string> }[] };

export type CustomerRow = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: string;
  plans: { planId: string; version: number; name: string; status: string; paid: boolean }[];
};

export type Subscription = {
  id: string;
  planId: string;
  planName: string;
  version: number;
  status: string;
  price: { amount: string; period: string } | null;
  ceiling: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  wallet: string | null;
  replacedBy: string | null;
  scheduledChange: { name: string; effectiveAt: string } | null;
  endedReason: string | null;
};

export type Balance = { featureId: string; balance: string; granted: string; breakdown: { source: string }[] };

export type Invoice = {
  id: string;
  createdAt: string;
  kind: string;
  total: string;
  status: string;
  lines: { kind: string; featureId?: string | null; quantity?: string | null; amount: string }[];
  payments: { signature: string }[];
};

export type Customer = {
  id: string;
  name: string | null;
  email: string | null;
  subscriptions: Subscription[];
  balances: Balance[];
  invoices: Invoice[];
};

export type UsageEvent = { id?: string; customerId: string; featureId: string; value: string; occurredAt: string; properties?: Record<string, unknown> | null };

export type PlanVersion = {
  planId: string;
  version: number;
  name: string;
  status: string;
  paid: boolean;
  base: string;
  onchainTerms: { amount: string; periodHours: number; ceiling: string; period: string; planId: string; metadataUri: string } | null;
  published: { address: string; owner: string | null; publishedAt: string | null } | null;
};

export type ApiKey = { id: string; env: Env; prefix: string; createdAt: string; revokedAt: string | null };
