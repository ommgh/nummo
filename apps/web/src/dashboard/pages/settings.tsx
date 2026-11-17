import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { authClient } from "@/lib/auth-client";
import { CopyButton, PageHeader, Panel } from "@/dashboard/ui";
import { useSession } from "@/dashboard/session";

type Member = { id: string; role: string; user: { name: string; email: string } };

export function SettingsPage() {
  const { session, refresh } = useSession();
  const org = session.org!;
  const [name, setName] = useState(org.name);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const canManage = org.role === "owner" || org.role === "admin";

  useEffect(() => {
    void authClient.organization.getFullOrganization({ query: { organizationId: org.id } }).then((r) => setMembers((r.data?.members as Member[] | undefined) ?? []));
  }, [org.id]);

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await authClient.organization.update({ organizationId: org.id, data: { name } });
    setBusy(false);
    if (r.error) return toast.error(r.error.message ?? "Could not rename");
    toast.success("Saved");
    await refresh();
  }

  return (
    <>
      <PageHeader description="Your organization and who can open it." title="Settings" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Organization">
          <form className="grid gap-4 p-5" onSubmit={rename}>
            <div className="grid gap-2">
              <Label htmlFor="org-name">Name</Label>
              <Input disabled={!canManage} id="org-name" onChange={(e) => setName(e.target.value)} value={name} />
            </div>
            <div className="grid gap-2">
              <Label>Organization id</Label>
              <div className="flex items-center gap-2 border bg-muted/20 px-3 py-1.5">
                <code className="flex-1 text-xs">{org.id}</code>
                <CopyButton value={org.id} />
              </div>
            </div>
            {canManage && (
              <div>
                <Button disabled={busy || name === org.name || !name.trim()} type="submit">
                  Save
                </Button>
              </div>
            )}
          </form>
        </Panel>
        <Panel description="Everyone in this organization sees both test and live data." title="Members">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="ps-5">Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="pe-5">Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="ps-5">{m.user.name}</TableCell>
                  <TableCell className="text-muted-foreground">{m.user.email}</TableCell>
                  <TableCell className="pe-5 capitalize">{m.role}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
        <Panel title="Your account">
          <div className="grid gap-1 p-5 text-sm">
            <span>{session.user.name}</span>
            <span className="text-muted-foreground">{session.user.email}</span>
          </div>
        </Panel>
      </div>
    </>
  );
}
