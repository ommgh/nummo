import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { MagnifyingGlassIcon, UsersIcon } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import type { CustomerRow } from "@/lib/types";
import { date, isWalletCustomer } from "@/lib/format";
import { EmptyNote, ErrorNote, LoadingRows, PageHeader, Panel, StatusBadge } from "@/dashboard/ui";

const PAGE = 50;

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const offset = Number(params.get("offset") ?? 0) || 0;
  const [text, setText] = useState(q);
  const navigate = useNavigate();
  useEffect(() => setText(q), [q]);
  // Search as you type, with a short pause.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== q) setParams(text ? { q: text } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [text, q, setParams]);
  const { data, error, loading, reload } = useApi<{ total: number; customers: CustomerRow[] }>(
    `/customers?${new URLSearchParams({ ...(q ? { q } : {}), offset: String(offset), limit: String(PAGE) })}`,
  );

  return (
    <>
      <PageHeader description="Everyone your app has called nummo about: their plans, balances, usage and invoices." title="Customers" />
      <Panel
        actions={
          <div className="relative w-full sm:w-72">
            <MagnifyingGlassIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search customers" className="pl-8" onChange={(e) => setText(e.target.value)} placeholder="Search id, name or email" value={text} />
          </div>
        }
        title={data ? `${data.total.toLocaleString()} customer${data.total === 1 ? "" : "s"}` : "Customers"}
      >
        {error ? (
          <div className="p-4">
            <ErrorNote error={error} onRetry={reload} />
          </div>
        ) : !data && loading ? (
          <LoadingRows />
        ) : data && data.customers.length === 0 ? (
          <EmptyNote icon={<UsersIcon />} title={q ? "No customers match" : "No customers yet"}>
            {q ? "Try an id, a name or an email address." : "A customer appears the first time your server calls check, track or attach for them."}
          </EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="ps-5">Customer</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Plans</TableHead>
                  <TableHead className="pe-5 text-right">Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.customers.map((c) => (
                  <TableRow
                    className="h-14 cursor-pointer"
                    key={c.id}
                    onClick={() => navigate(`/dashboard/customers/${encodeURIComponent(c.id)}`)}
                  >
                    <TableCell className="ps-5">
                      <Link className="font-medium hover:text-sol-green" onClick={(e) => e.stopPropagation()} to={`/dashboard/customers/${encodeURIComponent(c.id)}`}>
                        {c.name || c.id}
                      </Link>
                      {c.name && <div className="text-[11px] text-muted-foreground">{c.id}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.email}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {c.plans.length === 0 &&
                          (isWalletCustomer(c.id) ? (
                            <span className="inline-flex items-center border border-sol-purple/50 px-1.5 py-0.5 text-sol-purple text-xs">Agent · pays per request</span>
                          ) : (
                            <span className="text-muted-foreground text-xs">none</span>
                          ))}
                        {c.plans.map((p) => (
                          <span className="inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-xs" key={`${p.planId}-${p.version}`}>
                            {p.name}
                            {p.status !== "active" && <StatusBadge status={p.status} />}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="pe-5 text-right text-muted-foreground">{date(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data && data.total > PAGE && (
          <div className="flex items-center justify-between border-t px-5 py-3 text-muted-foreground text-xs">
            <span>
              {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex gap-2">
              <Button disabled={offset === 0} onClick={() => setParams({ ...(q ? { q } : {}), offset: String(Math.max(offset - PAGE, 0)) })} size="sm" variant="outline">
                Previous
              </Button>
              <Button disabled={offset + PAGE >= data.total} onClick={() => setParams({ ...(q ? { q } : {}), offset: String(offset + PAGE) })} size="sm" variant="outline">
                Next
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
