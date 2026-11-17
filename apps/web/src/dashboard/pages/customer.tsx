import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { ArrowLeftIcon, ArrowSquareOutIcon, PlusIcon, ReceiptIcon, WalletIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { Customer, UsageEvent } from "@/lib/types";
import { dateTime, num, usdc } from "@/lib/format";
import { AddressLink, EmptyNote, ErrorNote, LoadingRows, PageHeader, Panel, StatusBadge, TxLink } from "@/dashboard/ui";
import { useSession } from "@/dashboard/session";

export function CustomerPage() {
  const { id = "" } = useParams();
  const { data, error, reload } = useApi<{ customer: Customer; events: UsageEvent[] }>(`/customers/${encodeURIComponent(id)}`);
  const { env } = useSession();
  const [opening, setOpening] = useState(false);

  async function openPortal() {
    setOpening(true);
    try {
      const r = await api<{ url: string }>(`/customers/${encodeURIComponent(id)}/portal`, { body: {}, env });
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOpening(false);
    }
  }

  const c = data?.customer;
  return (
    <>
      <Link className="mb-4 inline-flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground" to="/dashboard/customers">
        <ArrowLeftIcon className="size-3" /> Customers
      </Link>
      <PageHeader
        actions={
          <Button disabled={opening} onClick={() => void openPortal()} variant="outline">
            Billing portal <ArrowSquareOutIcon />
          </Button>
        }
        description={c ? [c.name && c.id !== c.name ? c.id : null, c.email].filter(Boolean).join(" · ") || "No name or email on file" : undefined}
        title={c?.name || id}
      />
      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !c ? (
        <LoadingRows rows={8} />
      ) : (
        <div className="grid gap-6">
          <Panel description="Plans this customer is on, and where each one stands." title="Subscriptions">
            {c.subscriptions.length === 0 ? (
              <EmptyNote title="No subscriptions">attach() a plan to this customer to start one.</EmptyNote>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="ps-5">Plan</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Ceiling</TableHead>
                      <TableHead>Renews / ends</TableHead>
                      <TableHead>Wallet</TableHead>
                      <TableHead className="pe-5">Note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.subscriptions.map((s) => (
                      <TableRow className="h-12" key={s.id}>
                        <TableCell className="ps-5 font-medium">
                          {s.planName} <span className="text-muted-foreground text-xs">v{s.version}</span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={s.status} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{s.price ? `${usdc(s.price.amount)} / ${s.price.period}` : "free"}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.ceiling ? usdc(s.ceiling) : ""}</TableCell>
                        <TableCell className="text-muted-foreground">{dateTime(s.cancelAt ?? s.currentPeriodEnd)}</TableCell>
                        <TableCell>{s.wallet ? <AddressLink address={s.wallet} /> : ""}</TableCell>
                        <TableCell className="max-w-64 whitespace-normal pe-5 text-muted-foreground text-xs">
                          {s.replacedBy ? "replaced by a plan change" : s.scheduledChange ? `moves to ${s.scheduledChange.name} on ${dateTime(s.scheduledChange.effectiveAt)}` : (s.endedReason ?? "")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel actions={<GrantDialog customerId={id} onDone={reload} />} description="Credits and metered allowances left this period." title="Balances">
              {c.balances.length === 0 ? (
                <EmptyNote icon={<WalletIcon />} title="No balances" />
              ) : (
                <ul className="divide-y">
                  {c.balances.map((b) => {
                    const left = Number(b.balance);
                    const granted = Number(b.granted);
                    const pct = granted > 0 ? Math.max(0, Math.min(100, (left / granted) * 100)) : 0;
                    return (
                      <li className="space-y-2 px-5 py-3.5" key={b.featureId}>
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="font-medium">{b.featureId}</span>
                          <span className="tabular-nums">
                            {num(b.balance)} <span className="text-muted-foreground text-xs">/ {num(b.granted)}</span>
                          </span>
                        </div>
                        <div className="h-1.5 bg-muted">
                          <div className="h-full bg-gradient-sol" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="text-[11px] text-muted-foreground">from {[...new Set(b.breakdown.map((g) => g.source))].join(", ") || "—"}</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
            <Panel description="The latest tracked events." title="Recent usage">
              {data.events.length === 0 ? (
                <EmptyNote title="No usage yet" />
              ) : (
                <div className="max-h-80 overflow-y-auto">
                  <Table>
                    <TableBody>
                      {data.events.map((e, i) => (
                        <TableRow key={e.id ?? i}>
                          <TableCell className="ps-5 text-muted-foreground text-xs">{dateTime(e.occurredAt)}</TableCell>
                          <TableCell>{e.featureId}</TableCell>
                          <TableCell className="pe-5 text-right tabular-nums">{num(e.value)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel description="Every charge, with the transactions that paid it." title="Invoices">
            {c.invoices.length === 0 ? (
              <EmptyNote icon={<ReceiptIcon />} title="No invoices" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="ps-5">Created</TableHead>
                      <TableHead>Kind</TableHead>
                      <TableHead>Lines</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="pe-5">Paid by</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.invoices.map((inv) => (
                      <TableRow className="h-12" key={inv.id}>
                        <TableCell className="ps-5 text-muted-foreground">{dateTime(inv.createdAt)}</TableCell>
                        <TableCell className="capitalize">{inv.kind}</TableCell>
                        <TableCell className="max-w-72 whitespace-normal text-muted-foreground text-xs">
                          {inv.lines.map((l) => `${l.kind}${l.featureId ? ` ${l.featureId}` : ""}${l.quantity ? ` ×${num(l.quantity)}` : ""}: ${usdc(l.amount)}`).join("; ")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{usdc(inv.total)}</TableCell>
                        <TableCell>
                          <StatusBadge status={inv.status} />
                        </TableCell>
                        <TableCell className="pe-5">
                          <div className="flex flex-wrap gap-2">
                            {inv.payments.map((p) => (
                              <TxLink key={p.signature} signature={p.signature} />
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

function GrantDialog({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [featureId, setFeatureId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const { env } = useSession();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/customers/${encodeURIComponent(customerId)}/grant`, { body: { featureId, amount }, env });
      toast.success(`Granted ${amount} ${featureId}`);
      setOpen(false);
      setFeatureId("");
      setAmount("");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <PlusIcon /> Grant
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Grant a balance</DialogTitle>
            <DialogDescription>Add credits or allowance by hand, for support or a goodwill gesture. No charge is made.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="g-feature">Feature</Label>
            <Input id="g-feature" onChange={(e) => setFeatureId(e.target.value)} placeholder="credits" required value={featureId} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="g-amount">Amount</Label>
            <Input id="g-amount" inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder="500" required value={amount} />
          </div>
          <DialogFooter>
            <Button disabled={busy} type="submit">
              Grant
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
