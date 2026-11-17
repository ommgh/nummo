import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "./layout";
import { SocialButtons } from "./social";

export function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (r.error) return setError(r.error.message ?? "Could not sign in");
    navigate(next);
  }

  return (
    <AuthLayout
      footer={
        <>
          New to nummo?{" "}
          <Link className="text-foreground underline underline-offset-4 hover:text-sol-green" to={`/sign-up${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>
            Create an account
          </Link>
        </>
      }
      subtitle="Sign in to your billing dashboard."
      title="Welcome back"
    >
      <SocialButtons next={next} />
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input autoComplete="email" className="h-10" id="email" onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required type="email" value={email} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input autoComplete="current-password" className="h-10" id="password" onChange={(e) => setPassword(e.target.value)} required type="password" value={password} />
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button className="h-10" disabled={busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** Only same-site paths, so a crafted link cannot bounce people elsewhere after signing in. */
export function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}
