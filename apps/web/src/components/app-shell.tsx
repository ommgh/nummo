import { useLocation } from "react-router";
import { cn } from "@/lib/utils";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { useSession } from "@/dashboard/session";
import { useApplyTheme } from "@/lib/theme";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const { env } = useSession();
  useApplyTheme();
  return (
    <SidebarProvider className={cn("[--app-wrapper-max-width:84rem]")}>
      <AppSidebar pathname={pathname} />
      <SidebarInset>
        <AppHeader pathname={pathname} />
        {env === "test" && (
          <div className="label-mono grain border-b bg-marigold px-4 py-1.5 text-center text-[10.5px] text-ink md:px-6">
            Test mode: devnet data and devnet USDC. Switch to Live for mainnet.
          </div>
        )}
        <div className={cn("flex flex-1 flex-col p-4 md:p-8", "mx-auto w-full max-w-(--app-wrapper-max-width)")}>{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
