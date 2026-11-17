import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { FullPageSpinner } from "@/components/brand";
import { AuthLayout } from "./layout";
import { safeNext } from "./sign-in";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** A new account names its organization: the billing account its customers, plans and keys belong to. */
export function OnboardingPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session.isPending) return;
    if (!session.data) navigate("/sign-in?next=/onboarding", { replace: true });
    else if (session.data.session.activeOrganizationId) navigate(next, { replace: true });
  }, [session.isPending, session.data, navigate, next]);

  if (session.isPending || !session.data) return <FullPageSpinner />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const slug = `${slugify(name) || "org"}-${Math.random().toString(36).slice(2, 7)}`;
    const r = await authClient.organization.create({ name, slug });
    if (r.error) {
      setBusy(false);
      return setError(r.error.message ?? "Could not create the organization");
    }
    await authClient.organization.setActive({ organizationId: r.data.id });
    navigate("/dashboard", { replace: true });
  }

  return (
    <AuthLayout subtitle="Customers, plans and API keys belong to an organization. You can invite your team later." title="Name your organization">
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="org">Company or project</Label>
          <Input autoFocus className="h-10" id="org" onChange={(e) => setName(e.target.value)} placeholder="Acme AI" required value={name} />
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button className="h-10" disabled={busy || !name.trim()} type="submit">
          {busy ? "Creating…" : "Continue to the dashboard"}
        </Button>
      </form>
    </AuthLayout>
  );
}
