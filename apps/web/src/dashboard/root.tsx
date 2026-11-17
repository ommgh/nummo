import { Suspense } from "react";
import { Outlet } from "react-router";
import { AppShell } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { SessionProvider } from "./session";

export function DashboardRoot() {
  return (
    <SessionProvider>
      <AppShell>
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </SessionProvider>
  );
}
