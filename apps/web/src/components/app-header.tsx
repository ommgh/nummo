import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DecorIcon } from "@/components/decor-icon";
import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { isActivePath, navLinks } from "@/components/app-shared";
import { CustomSidebarTrigger } from "@/components/custom-sidebar-trigger";
import { NavUser } from "@/components/nav-user";
import { EnvSwitch } from "@/components/env-switch";
import { BookOpenIcon } from "@phosphor-icons/react";

export function AppHeader({ pathname }: { pathname: string }) {
  const activeItem = navLinks.find((item) => !item.external && isActivePath(item.path, pathname));
  return (
    <header
      className={cn(
        "sticky top-0 z-50 flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4 md:px-6",
        "bg-background/80 backdrop-blur-md",
      )}
    >
      <DecorIcon className="hidden md:block" position="bottom-left" />
      <div className="flex min-w-0 items-center gap-3">
        <CustomSidebarTrigger />
        <Separator className="mr-1 h-4 data-[orientation=vertical]:self-center" orientation="vertical" />
        <AppBreadcrumbs page={activeItem} />
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <EnvSwitch />
        <Button asChild className="hidden sm:inline-flex" size="icon-sm" variant="outline">
          <a aria-label="Documentation" href="https://github.com/ommgh/nummo/tree/master/docs/guide" rel="noopener" target="_blank">
            <BookOpenIcon />
          </a>
        </Button>
        <Separator className="h-4 data-[orientation=vertical]:self-center" orientation="vertical" />
        <NavUser />
      </div>
    </header>
  );
}
