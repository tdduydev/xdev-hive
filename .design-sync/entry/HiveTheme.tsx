import { useLayoutEffect, type ReactNode } from "react";
import { cn } from "cn";
import { TooltipProvider } from "@xdev-hive/ui/components/ui/tooltip";

export type HiveThemeName = "dark" | "light";

export interface HiveThemeProps {
  /** "dark" is the design's own look (cosmic); "light" is derived from it. */
  theme?: HiveThemeName;
  className?: string;
  children?: ReactNode;
}

/**
 * The xDev Hive theme root: wrap a design (or a preview) in it once. It sets data-theme on its own div and on <body>,
 * paints its box with the canvas background and the base text style, and supplies the TooltipProvider the app root
 * normally does. Dark by default. For a full-page design give it `className="min-h-screen"`.
 */
export function HiveTheme({ theme = "dark", className, children }: HiveThemeProps) {
  // Radix portals (dialogs, menus, selects, tooltips) mount on <body>, outside this div, so they need the attribute
  // there too. <body>, not <html> as the app's lib/theme.ts does: <html> paints the page canvas, which would turn the
  // white frame of every preview card around the component dark as well.
  useLayoutEffect(() => {
    const body = document.body;
    const prevTheme = body.getAttribute("data-theme");
    const prevScheme = body.style.colorScheme;
    body.setAttribute("data-theme", theme);
    body.style.colorScheme = theme;
    return () => {
      if (prevTheme === null) body.removeAttribute("data-theme");
      else body.setAttribute("data-theme", prevTheme);
      body.style.colorScheme = prevScheme;
    };
  }, [theme]);
  return (
    <TooltipProvider>
      {/* The div's own data-theme gives the right colours on the first paint, before the effect runs. */}
      <div data-theme={theme} className={cn("bg-background text-foreground type-body-md antialiased", className)}>
        {children}
      </div>
    </TooltipProvider>
  );
}
