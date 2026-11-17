import { Fragment, useState } from "react";
import { WebhooksLogoIcon } from "@phosphor-icons/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import type { WebhookEvent } from "@/lib/types";
import { dateTime, eventLabel } from "@/lib/format";
import { CopyButton, EmptyNote, ErrorNote, LoadingRows, PageHeader, Panel, StatusBadge } from "@/dashboard/ui";
import { useSession } from "@/dashboard/session";

export function WebhooksPage() {
  const { data, error, reload } = useApi<{ endpoint: { url: string; createdAt: string } | null; events: WebhookEvent[] }>("/webhooks");
  const [open, setOpen] = useState<string | null>(null);
  const { session } = useSession();
  const register = `curl -X PUT ${session.publicUrl}/v1/webhook \\\n  -H "authorization: Bearer $NUMMO_SECRET_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"url":"https://your.app/webhooks/nummo"}'`;
  return (
    <>
      <PageHeader description="nummo tells your server when subscriptions start, renew, fail or end, and when payments land. Retries with backoff; signed with your endpoint secret." title="Webhooks" />
      {error ? (
        <ErrorNote error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingRows />
      ) : (
        <div className="grid gap-6">
          <Panel title="Endpoint">
            {data.endpoint ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <code className="break-all text-sm">{data.endpoint.url}</code>
                <span className="text-muted-foreground text-xs">since {dateTime(data.endpoint.createdAt)}</span>
              </div>
            ) : (
              <div className="space-y-3 px-5 py-4">
                <p className="text-muted-foreground text-sm">No endpoint yet: events are kept, but not sent. Register one with your secret key:</p>
                <div className="relative border bg-muted/30">
                  <pre className="overflow-x-auto p-4 text-xs leading-relaxed">{register}</pre>
                  <div className="absolute top-2 right-2">
                    <CopyButton value={register} />
                  </div>
                </div>
              </div>
            )}
          </Panel>
          <Panel title="Events">
            {data.events.length === 0 ? (
              <EmptyNote icon={<WebhooksLogoIcon />} title="No events yet" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="ps-5">When</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead className="text-right">Attempts</TableHead>
                      <TableHead className="pe-5">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.events.map((e) => (
                      <Fragment key={e.id}>
                        <TableRow className="h-12 cursor-pointer" onClick={() => setOpen(open === e.id ? null : e.id)}>
                          <TableCell className="ps-5 text-muted-foreground">{dateTime(e.createdAt)}</TableCell>
                          <TableCell>
                            {eventLabel(e.type)}
                            <div className="font-mono text-[11px] text-muted-foreground">{e.type}</div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={e.state} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{e.attempts}</TableCell>
                          <TableCell className="max-w-80 truncate pe-5 font-mono text-muted-foreground text-xs">{e.lastError ?? "view payload"}</TableCell>
                        </TableRow>
                        {open === e.id && (
                          <TableRow>
                            <TableCell className="bg-muted/20 p-0" colSpan={5}>
                              <pre className="max-h-72 overflow-auto p-4 text-xs leading-relaxed">{JSON.stringify(e.payload, null, 2)}</pre>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
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
