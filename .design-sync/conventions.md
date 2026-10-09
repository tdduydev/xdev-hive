# Designing with @xdev-hive/ui

Import from `'@xdev-hive/ui'` (= `window.XdevHive`).

## 1. Wrap each screen in one HiveTheme

```tsx
<HiveTheme className="min-h-screen">{/* theme="dark" default; "light" derived */}
  <Page>…</Page>
</HiveTheme>
```

Without it, everything takes the light values on `:root` and `Tooltip` throws (HiveTheme supplies `TooltipProvider`). Portals (Dialog, Select, menus) mount on `<body>`; HiveTheme themes it too. Built-in copy is Vietnamese (no i18n provider); match it.

- `Sidebar`, `SidebarMenuButton`, `SidebarRail`, `SidebarTrigger` throw outside `SidebarProvider`; put the page in `SidebarInset`. Below 768px `collapsible="offcanvas"`/`"icon"` hides the sidebar; `"none"` always shows it.
- `ScrollArea` needs a height (`h-48` or `style`); `type="always"` shows the scrollbar.
- Vertical `Separator` takes its parent's height; size the parent.
- `HiveWordmark` `height` ≥ 24; smaller, use `XMark`.
- Show an overlay open with `defaultOpen` (Tooltip: `open`).
- `ToggleGroup`: always pass `variant` (`"outline"` = segmented control).
- Status: `CommonBadge tone={STATUS_TONE[status]}` or `Badge tone`. `Tag tone` is unstyled; use `Tag active`.

## 2. Only shipped utilities and tokens

Tailwind v4, compiled ahead of time: only classes in `_ds_bundle.css` work. Anything else is a no-op: new `[…]`, `h-64`, `gap-8`, `grid-cols-4` (use `md:grid-cols-4`). One-off sizes: `style` with tokens. No hex, palette colours (`bg-blue-500`) or `dark:`; tokens follow the theme.

| Family | Classes |
|---|---|
| Surface | `bg-canvas`, `bg-surface`, `bg-raised`, `bg-sunken`, `bg-selected` + `text-selected-fg`; glass panel `rounded-[24px] bg-card shadow-[var(--ring-glass)]` |
| Text | `text-fg-strong`, `text-fg-primary`, `text-fg-secondary`, `text-fg-muted` |
| Lines | `border`/`border-b`/`border-t` + `border-line-subtle` or `border-line-default`; `last:border-b-0` |
| Status | `text-success` on `bg-success-soft`; also `warning`, `danger`, `info`, `running`, `neutral` |
| Type | `type-display-md`, `type-heading-md`, `type-heading-sm`, `type-body-md`, `type-body-sm`, `type-label`, `type-caption`, `type-numeric-lg`; `font-mono` for ids |
| Layout | `grid-cols-2`, `grid-cols-3`, `gap-1`…`gap-6`, `p-2`…`p-6`, `min-w-0`, `truncate` |
| Shape | `rounded-xs`…`rounded-xl`, `rounded-full`, `shadow-e1`…`shadow-e4` |

Tokens: `var(--surface-1)`…`(--surface-4)`, `--bg-canvas`, `--text-primary`, `--text-muted`, `--border-subtle`, `--border-default`, `--accent-violet`, `--accent-blue`, `--ring-glass`, `--radius-card`, `--space-4` (N×4px).

## 3. Where the truth lives

- `styles.css` imports `fonts/fonts.css` and `_ds_bundle.css`: all utilities, and token values in its `[data-theme="dark"]` blocks (`tokens/` is empty). Grep it (`.gap-1\.5`) before using a class.
- Per component: `components/<group>/<Name>/<Name>.prompt.md` (usage, example) and `<Name>.d.ts` (the only props).

## 4. A typical screen

```tsx
const tasks = [{ id: "R-73a", title: "Đẩy nhánh lên remote", status: "review", label: "Chờ review" }];

<HiveTheme className="min-h-screen">
  <Page>{/* pads 24px, stacks with gap-6 */}
    <PageHeader title="Tổng quan" actions={<Button variant="solid" size="sm">Giao việc</Button>} />
    <div className="grid grid-cols-2 gap-4">
      <StatTile label="Run đang chạy" value="3" detail="trên 2 máy" />
      <StatTile label="Task chờ review" value="7" />
    </div>
    <Card>
      <CardHeader className="border-b"><CardTitle>Chờ bạn duyệt</CardTitle></CardHeader>
      <CardContent className="flex flex-col">
        {tasks.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-3 border-b border-line-subtle py-2.5 last:border-b-0">
            <span className="truncate text-sm text-fg-strong">{t.title}</span>
            <CommonBadge tone={STATUS_TONE[t.status]}>{t.label}</CommonBadge>
          </div>
        ))}
      </CardContent>
    </Card>
  </Page>
</HiveTheme>
```
