import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { setTheme, useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button aria-label={`Switch to ${next} mode`} onClick={() => setTheme(next)} size="icon-sm" variant="outline">
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
