import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { LogoMark } from "@/components/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { footerNavLinks, navGroups } from "@/components/app-shared";
import { LatestChange } from "@/components/latest-change";
import { NavGroup } from "@/components/nav-group";
import { useSession } from "@/dashboard/session";

export function AppSidebar({ pathname }: { pathname: string }) {
  const { session } = useSession();
  return (
    <Sidebar
      className={cn(
        "*:data-[slot=sidebar-inner]:bg-sidebar",
        "*:data-[slot=sidebar-inner]:dark:bg-[radial-gradient(70%_20%_at_0%_0%,rgb(153_69_255/0.14),transparent)]",
        "**:data-[slot=sidebar-menu-button]:[&>span]:text-foreground/80",
      )}
      collapsible="icon"
      variant="sidebar"
    >
      <SidebarHeader className="h-14 justify-center border-b px-2">
        <SidebarMenuButton asChild size="lg" tooltip="nummo">
          <Link to="/dashboard">
            <LogoMark className="size-5 shrink-0" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="font-display font-semibold text-foreground! text-sm">nummo</span>
              <span className="truncate text-[10px] text-muted-foreground!">{session.org?.name}</span>
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group, index) => (
          <NavGroup key={`sidebar-group-${index}`} {...group} pathname={pathname} />
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-0 p-0">
        <LatestChange />
        <SidebarMenu className="border-t p-2">
          {footerNavLinks.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild className="text-muted-foreground" size="sm" tooltip={item.title}>
                <a href={item.path} rel="noopener" target="_blank">
                  {item.icon}
                  <span>{item.title}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
