---
category: Theme
---
# HiveTheme

The theme root: wrap every design in it once. It applies the xDev Hive tokens (dark by default; light is derived from the dark cosmic design), paints the canvas background with the base text style (Inter 14/22), puts `data-theme` on `<body>` so dialogs, menus and tooltips that portal there match, and provides the `TooltipProvider` the app root normally supplies.

**Key props**: `theme`: `"dark"` (default) | `"light"`; `className` (use `min-h-screen` for a full page); `children`.

Design with the semantic utility classes the components use: surfaces `bg-canvas` / `bg-surface` / `bg-raised` / `bg-sunken`, text `text-fg-strong` / `text-fg-secondary` / `text-fg-muted`, borders `border-line-subtle` / `border-line-default`, status `text-success` / `bg-danger-soft`, type `type-heading-md` / `type-body-sm` / `type-caption`.

```tsx
<HiveTheme theme="dark" className="min-h-screen">
  <Page>
    <PageHeader title="Bảng task" />
  </Page>
</HiveTheme>
```
