import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "./layout";
import { SocialButtons } from "./social";
import { safeNext } from "./sign-in";

export function SignUpPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await authClient.signUp.email({ name, email, password });
    setBusy(false);
    if (r.error) return setError(r.error.message ?? "Could not create the account");
    navigate(`/onboarding?next=${encodeURIComponent(next)}`);
  }

  return (
    <AuthLayout
      footer={
        <>
          Already have an account?{" "}
          <Link className="text-foreground underline underline-offset-4 hover:text-sol-green" to="/sign-in">
            Sign in
          </Link>
        </>
      }
      subtitle="Free and open source. Start on devnet, no card and no wallet needed."
      title="Create your account"
    >
      <SocialButtons next="/onboarding" />
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="name">Your name</Label>
          <Input autoComplete="name" className="h-10" id="name" onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required value={name} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="email">Work email</Label>
          <Input autoComplete="email" className="h-10" id="email" onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required type="email" value={email} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <Input autoComplete="new-password" className="h-10" id="password" minLength={10} onChange={(e) => setPassword(e.target.value)} required type="password" value={password} />
          <p className="text-[11px] text-muted-foreground">At least 10 characters.</p>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
        <Button className="h-10" disabled={busy} type="submit">
          {busy ? "Creating…" : "Create account"}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          By creating an account you agree to the{" "}
          <Link className="underline underline-offset-4 hover:text-foreground" target="_blank" to="/terms">
            Terms
          </Link>{" "}
          and{" "}
          <Link className="underline underline-offset-4 hover:text-foreground" target="_blank" to="/privacy">
            Privacy Policy
          </Link>
          .
        </p>
      </form>
    </AuthLayout>
  );
}
