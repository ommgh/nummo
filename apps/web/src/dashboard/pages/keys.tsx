import { useState } from "react";
import { toast } from "sonner";
import { KeyIcon, PlusIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import { api } from "@/lib/api";
import type { ApiKey } from "@/lib/types";
import { dateTime } from "@/lib/format";
import { CopyButton, EmptyNote, ErrorNote, LoadingRows, PageHeader, Panel, StatusBadge } from "@/dashboard/ui";
import { useSession } from "@/dashboard/session";

export function KeysPage() {
  const { data, error, reload } = useApi<{ keys: ApiKey[] }>("/keys");
  const { env, session } = useSession();
  const [created, setCreated] = useState<{ key: string; env: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = session.org?.role === "owner" || session.org?.role === "admin";

  async function create() {
    setBusy(true);
    try {
      const r = await api<{ key: string; env: string }>("/keys", { body: { env } });
      setCreated(r);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKey) {
    if (!window.confirm(`Revoke ${k.prefix}…? Requests with this key stop working straight away.`)) return;
    try {
      await api(`/keys/${k.id}/revoke`, { body: {} });
      toast.success("Key revoked");
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        actions={
          canManage && (
            <Button disabled={busy} onClick={() => void create()}>
              <PlusIcon /> New {env} key
            </Button>
          )
        }
        description="Secret keys for your server. Test keys see devnet data, live keys mainnet. Keep them out of browsers and repositories."
        title="API keys"
      />
      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingRows />
      ) : (
        <Panel title={`${data.keys.filter((k) => !k.revokedAt).length} active`}>
          {data.keys.length === 0 ? (
            <EmptyNote icon={<KeyIcon />} title="No keys yet">
              Create a test key to start on devnet.
            </EmptyNote>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="ps-5">Key</TableHead>
                    <TableHead>Environment</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="pe-5 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.keys.map((k) => (
                    <TableRow className="h-12" key={k.id}>
                      <TableCell className="ps-5 font-mono text-xs">{k.prefix}…</TableCell>
                      <TableCell>
                        <span className={k.env === "live" ? "text-success" : "text-warning"}>{k.env === "live" ? "live · mainnet" : "test · devnet"}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{dateTime(k.createdAt)}</TableCell>
                      <TableCell>{k.revokedAt ? <StatusBadge status="revoked" /> : <StatusBadge status="active" />}</TableCell>
                      <TableCell className="pe-5 text-right">
                        {!k.revokedAt && canManage && (
                          <Button onClick={() => void revoke(k)} size="sm" variant="ghost">
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Panel>
      )}
      <Dialog onOpenChange={(o) => !o && setCreated(null)} open={!!created}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your new {created?.env} key</DialogTitle>
            <DialogDescription className="flex items-start gap-2">
              <WarningIcon className="mt-0.5 size-4 shrink-0 text-warning" />
              Copy it now. It is shown once; we only keep its hash.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 border bg-muted/30 p-3">
            <code className="flex-1 break-all text-xs">{created?.key}</code>
            {created && <CopyButton value={created.key} />}
          </div>
          <pre className="overflow-x-auto border bg-muted/20 p-3 text-[11px] text-muted-foreground">{`NUMMO_SECRET_KEY=${created?.key ?? ""}\nNUMMO_API_URL=${session.publicUrl}`}</pre>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
