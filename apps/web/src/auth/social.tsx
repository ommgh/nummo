import { useEffect, useState } from "react";
import { GithubLogoIcon, GoogleLogoIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

type Providers = { email: boolean; github: boolean; google: boolean };

/** GitHub and Google buttons, shown only when the server has their credentials. */
export function SocialButtons({ next }: { next: string }) {
  const [p, setP] = useState<Providers | null>(null);
  useEffect(() => {
    fetch("/dashboard/api/providers")
      .then((r) => r.json())
      .then(setP)
      .catch(() => setP(null));
  }, []);
  if (!p || (!p.github && !p.google)) return null;
  const go = (provider: "github" | "google") => authClient.signIn.social({ provider, callbackURL: next });
  return (
    <>
      <div className="grid gap-2">
        {p.github && (
          <Button className="h-10" onClick={() => void go("github")} type="button" variant="outline">
            <GithubLogoIcon /> Continue with GitHub
          </Button>
        )}
        {p.google && (
          <Button className="h-10" onClick={() => void go("google")} type="button" variant="outline">
            <GoogleLogoIcon /> Continue with Google
          </Button>
        )}
      </div>
      <div className="my-6 flex items-center gap-3 text-[11px] text-muted-foreground uppercase tracking-widest">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}
