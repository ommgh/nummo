import { Link } from "react-router";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { isActivePath, type SidebarNavGroup } from "@/components/app-shared";

export function NavGroup({ label, items, pathname }: SidebarNavGroup & { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton asChild className="data-active:shadow-[inset_3px_0_0_var(--color-marigold)]" isActive={isActivePath(item.path, pathname)} tooltip={item.title}>
              <Link onClick={() => setOpenMobile(false)} to={item.path ?? "#"}>
                {item.icon}
                <span>{item.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
