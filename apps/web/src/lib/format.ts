const LOCALE = "en-US";

export function usdc(amount: string | number, opts: { compact?: boolean } = {}) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  if (opts.compact && Math.abs(n) >= 10_000) return new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return n.toLocaleString(LOCALE, { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 6 });
}

export function num(value: string | number) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(LOCALE, { maximumFractionDigits: 6 }) : String(value);
}

export function compact(value: string | number) {
  return new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
}

export function dateTime(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" }) : "";
}

export function date(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleDateString(LOCALE, { dateStyle: "medium" }) : "";
}

export function dayLabel(isoDay: string) {
  return new Date(`${isoDay}T12:00:00Z`).toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
}

export function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : date(iso);
}

export function short(s: string | null | undefined, head = 4, tail = 4) {
  if (!s) return "";
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

export function explorerTx(signature: string, network: string | undefined) {
  return `https://explorer.solana.com/tx/${signature}${network && network !== "mainnet" ? `?cluster=${network}` : ""}`;
}

export function explorerAddress(address: string, network: string | undefined) {
  return `https://explorer.solana.com/address/${address}${network && network !== "mainnet" ? `?cluster=${network}` : ""}`;
}

export function eventLabel(type: string) {
  return type.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
