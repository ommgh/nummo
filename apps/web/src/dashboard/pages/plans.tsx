import { useEffect, useState } from "react";
import { toast } from "sonner";
import { StackIcon, SealCheckIcon, WalletIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { PlanVersion, Settlement } from "@/lib/types";
import { usdc } from "@/lib/format";
import { connect, listWallets, onWalletsChange, signTransaction, type StandardWallet } from "@/lib/wallet";
import { AddressLink, EmptyNote, ErrorNote, LoadingRows, PageHeader, Panel, StatusBadge } from "@/dashboard/ui";
import { useSession } from "@/dashboard/session";

type Built = { transaction: string; message: string; lastValidBlockHeight: string; planAddress: string };

export function PlansPage() {
  const { data, error, reload } = useApi<{ settlement: Settlement; versions: PlanVersion[] }>("/plans");
  const [target, setTarget] = useState<PlanVersion | null>(null);
  return (
    <>
      <PageHeader
        description="Plans come from your pricing config (nummo push). Paid plans become Solana Subscriptions plans owned by your wallet: customers approve the ceiling once, and every payment lands in your wallet."
        title="Plans"
      />
      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingRows />
      ) : (
        <Panel
          actions={
            data.settlement ? (
              <span className="text-muted-foreground text-xs">
                {data.settlement.network} · mint <AddressLink address={data.settlement.mint} />
              </span>
            ) : (
              <StatusBadge status="settlement off" />
            )
          }
          title={`${data.versions.length} plan version${data.versions.length === 1 ? "" : "s"}`}
        >
          {data.versions.length === 0 ? (
            <EmptyNote icon={<StackIcon />} title="No plans yet">
              Write your features and plans in <code className="text-foreground">nummo.config.ts</code> and run <code className="text-foreground">nummo push</code>.
            </EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="ps-5">Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Base</TableHead>
                    <TableHead className="text-right">Ceiling</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="pe-5">On-chain</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.versions.map((v) => (
                    <TableRow className="h-14" key={`${v.planId}@${v.version}`}>
                      <TableCell className="ps-5">
                        <div className="font-medium">{v.name}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {v.planId}@{v.version}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={v.status} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{v.paid ? `${usdc(v.base)} USDC` : "free"}</TableCell>
                      <TableCell className="text-right tabular-nums">{v.onchainTerms ? `${usdc(v.onchainTerms.ceiling)} USDC` : ""}</TableCell>
                      <TableCell className="text-muted-foreground">{v.onchainTerms?.period ?? ""}</TableCell>
                      <TableCell className="pe-5">
                        {!v.paid ? (
                          <span className="text-muted-foreground text-xs">not needed</span>
                        ) : v.published ? (
                          <span className="inline-flex items-center gap-1.5">
                            <SealCheckIcon className="size-4 text-sol-green" weight="fill" />
                            <AddressLink address={v.published.address} />
                          </span>
                        ) : data.settlement ? (
                          <Button onClick={() => setTarget(v)} size="sm">
                            <WalletIcon /> Publish
                          </Button>
                        ) : (
                          <StatusBadge status="not published" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="border-t px-5 py-3 text-muted-foreground text-xs leading-relaxed">
            The amount and period of a published plan cannot change. A new version of the plan gets its own on-chain plan. From the CLI:{" "}
            <code className="text-foreground">nummo plans publish --keypair merchant.json</code>
          </p>
        </Panel>
      )}
      {target && data?.settlement && <PublishDialog network={data.settlement.network} onClose={() => setTarget(null)} onDone={reload} plan={target} />}
    </>
  );
}

function PublishDialog({ plan, network, onClose, onDone }: { plan: PlanVersion; network: string; onClose: () => void; onDone: () => void }) {
  const [wallets, setWallets] = useState<StandardWallet[]>(listWallets());
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const { env } = useSession();
  useEffect(() => onWalletsChange(() => setWallets(listWallets())) as unknown as () => void, []);

  async function publish(w: StandardWallet) {
    const base = `/plans/${encodeURIComponent(plan.planId)}/${plan.version}`;
    setBusy(true);
    try {
      setStatus(`Connecting to ${w.name}…`);
      const account = await connect(w);
      const built = await api<Built>(`${base}/transaction`, { body: { owner: account.address }, env });
      setStatus(`Approve the plan in ${w.name}. Your wallet pays the plan account's rent (a little SOL).`);
      const signedTransaction = await signTransaction(w, account, built.transaction, network);
      setStatus("Publishing on Solana…");
      await api(`${base}/submit`, { body: { owner: account.address, signedTransaction, message: built.message, lastValidBlockHeight: built.lastValidBlockHeight, planAddress: built.planAddress }, env });
      toast.success(`${plan.name} is live on ${network}`);
      onDone();
      onClose();
    } catch (e) {
      setStatus("");
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={(o) => !o && !busy && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish {plan.name}</DialogTitle>
          <DialogDescription>
            Up to {usdc(plan.onchainTerms?.ceiling ?? "0")} USDC every {plan.onchainTerms?.period}. Pick the merchant wallet that will own the plan and receive every payment.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {wallets.length === 0 ? (
            <p className="border border-dashed p-4 text-muted-foreground text-sm">
              No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload this page.
            </p>
          ) : (
            wallets.map((w) => (
              <Button className="h-11 justify-start gap-3" disabled={busy} key={w.name} onClick={() => void publish(w)} variant="outline">
                {w.icon && <img alt="" className="size-6" src={w.icon} />}
                Sign with {w.name}
              </Button>
            ))
          )}
        </div>
        {status && <p className="text-muted-foreground text-xs">{status}</p>}
      </DialogContent>
    </Dialog>
  );
}
