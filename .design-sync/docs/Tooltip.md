---
category: Overlays
---
# Tooltip

A short hint on hover or focus, rendered as a light chip on the dark theme (inverted against the page). Use it to name icon-only buttons and explain truncated values; never put essential content or actions in it.

**Composition**: `Tooltip` > `TooltipTrigger asChild` + `TooltipContent`. It needs a `TooltipProvider` above it; `HiveTheme` already supplies one (the app root does too).

**Key props**: `Tooltip` `open` / `defaultOpen` / `delayDuration`; `TooltipContent` `side` (`top` default), `sideOffset` (8).

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon-sm" aria-label="Chạy lại"><RotateCcw /></Button>
  </TooltipTrigger>
  <TooltipContent>Chạy lại trên cùng máy</TooltipContent>
</Tooltip>
```
