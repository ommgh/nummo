import type { ReactNode } from "react";
import {
  SquaresFourIcon,
  UsersIcon,
  StackIcon,
  CoinsIcon,
  ChartLineUpIcon,
  WebhooksLogoIcon,
  KeyIcon,
  GearIcon,
  BookOpenIcon,
  GithubLogoIcon,
} from "@phosphor-icons/react";

export type SidebarNavItem = {
  title: string;
  path?: string;
  icon?: ReactNode;
  external?: boolean;
  subItems?: SidebarNavItem[];
};

export type SidebarNavGroup = {
  label?: string;
  items: SidebarNavItem[];
};

export const navGroups: SidebarNavGroup[] = [
  {
    label: "Billing",
    items: [
      { title: "Overview", path: "/dashboard", icon: <SquaresFourIcon /> },
      { title: "Customers", path: "/dashboard/customers", icon: <UsersIcon /> },
      { title: "Plans", path: "/dashboard/plans", icon: <StackIcon /> },
      { title: "Payments", path: "/dashboard/payments", icon: <CoinsIcon /> },
      { title: "Usage", path: "/dashboard/usage", icon: <ChartLineUpIcon /> },
    ],
  },
  {
    label: "Developers",
    items: [
      { title: "API keys", path: "/dashboard/keys", icon: <KeyIcon /> },
      { title: "Webhooks", path: "/dashboard/webhooks", icon: <WebhooksLogoIcon /> },
    ],
  },
  {
    label: "Organization",
    items: [{ title: "Settings", path: "/dashboard/settings", icon: <GearIcon /> }],
  },
];

export const footerNavLinks: SidebarNavItem[] = [
  { title: "Documentation", path: "https://github.com/ommgh/nummo/tree/master/docs/guide", icon: <BookOpenIcon />, external: true },
  { title: "GitHub", path: "https://github.com/ommgh/nummo", icon: <GithubLogoIcon />, external: true },
];

export const navLinks: SidebarNavItem[] = [
  ...navGroups.flatMap((group) => group.items.flatMap((item) => (item.subItems?.length ? [item, ...item.subItems] : [item]))),
  ...footerNavLinks,
];

/** The nav item a path belongs to: exact for the overview, by prefix for the rest. */
export function isActivePath(itemPath: string | undefined, pathname: string) {
  if (!itemPath) return false;
  if (itemPath === "/dashboard") return pathname === "/dashboard" || pathname === "/dashboard/";
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}
