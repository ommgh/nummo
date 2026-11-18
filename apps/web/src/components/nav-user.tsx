import { useNavigate } from "react-router";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GearIcon, KeyIcon, SignOutIcon, HouseIcon } from "@phosphor-icons/react";
import { useSession } from "@/dashboard/session";
import { authClient } from "@/lib/auth-client";

export function NavUser() {
  const { session } = useSession();
  const navigate = useNavigate();
  const user = session.user;
  const initials = (user.name || user.email).slice(0, 1).toUpperCase();

  async function signOut() {
    await authClient.signOut();
    navigate("/sign-in");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button aria-label="Account" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar className="size-8">
            {user.image && <AvatarImage src={user.image} />}
            <AvatarFallback className="bg-marigold font-semibold text-ink">{initials}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="pointer-events-none">
            <div className="font-medium text-foreground">{user.name}</div>
            <div className="truncate text-muted-foreground text-xs">{user.email}</div>
            <div className="mt-1 text-[10px] text-muted-foreground uppercase tracking-wider">
              {session.org?.name} · {session.org?.role}
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => navigate("/dashboard/settings")}>
            <GearIcon />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/dashboard/keys")}>
            <KeyIcon />
            API keys
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => navigate("/")}>
            <HouseIcon />
            Website
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()} variant="destructive">
          <SignOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
