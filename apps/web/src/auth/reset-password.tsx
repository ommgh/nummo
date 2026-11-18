import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "./layout";

const linkClass = "text-foreground underline underline-offset-4 hover:text-sol-green";

/** Step 1: ask for a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    if (r.error) return setError(r.error.status === 429 ? "Too many requests. Wait a minute and try again." : (r.error.message ?? "Could not send the email"));
    setSent(true);
  }

  return (
    <AuthLayout
      footer={
        <>
          Remembered it?{" "}
          <Link className={linkClass} to="/sign-in">
            Sign in
          </Link>
        </>
      }
      subtitle={sent ? undefined : "We will email you a link to choose a new one."}
      title={sent ? "Check your email" : "Reset your password"}
    >
      {sent ? (
        <div className="grid gap-4 text-sm">
          <p>
            If an account uses <span className="font-medium">{email}</span>, a reset link is on its way. It works once, for one hour.
          </p>
          <p className="text-muted-foreground text-xs">Nothing after a few minutes? Check spam, or make sure you typed the address you signed up with.</p>
          <Button className="h-10" onClick={() => setSent(false)} variant="outline">
            Use another address
          </Button>
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input autoComplete="email" className="h-10" id="email" onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required type="email" value={email} />
          </div>
          {error && <p className="text-destructive text-xs">{error}</p>}
          <Button className="h-10" disabled={busy} type="submit">
            {busy ? "Sending…" : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** Step 2: the emailed link lands here with ?token=… (or ?error=INVALID_TOKEN when it is used or expired). */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!token || params.get("error")) {
    return (
      <AuthLayout subtitle="Reset links work once and expire after an hour." title="This link has expired">
        <Button asChild className="h-10 w-full">
          <Link to="/forgot-password">Send a new link</Link>
        </Button>
      </AuthLayout>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The passwords do not match");
    setBusy(true);
    setError("");
    const r = await authClient.resetPassword({ newPassword: password, token: token! });
    setBusy(false);
    if (r.error) {
      return setError(r.error.code === "INVALID_TOKEN" ? "This link has expired. Ask for a new one." : (r.error.message ?? "Could not reset the password"));
    }
    navigate("/sign-in?reset=1");
  }

  return (
    <AuthLayout subtitle="At least 10 characters. You will be signed out everywhere else." title="Choose a new password">
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="password">New password</Label>
          <Input autoComplete="new-password" className="h-10" id="password" minLength={10} onChange={(e) => setPassword(e.target.value)} required type="password" value={password} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="confirm">Confirm it</Label>
          <Input autoComplete="new-password" className="h-10" id="confirm" minLength={10} onChange={(e) => setConfirm(e.target.value)} required type="password" value={confirm} />
        </div>
        {error && (
          <p className="text-destructive text-xs">
            {error}{" "}
            {error.includes("expired") && (
              <Link className={linkClass} to="/forgot-password">
                Send a new link
              </Link>
            )}
          </p>
        )}
        <Button className="h-10" disabled={busy} type="submit">
          {busy ? "Saving…" : "Set new password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
