---
category: Actions
---
# Button

The action control. Most screens use `variant="outline"` or `"ghost"` at `size="sm"`; the 2026-10 cosmic look adds `solid` (violet primary), `glass`, `blue` and `ghost` at the taller `md` height.

**Key props**
- `variant`: `solid` | `glass` | `blue` | `ghost` (cosmic), `default` (violet fill), `outline` / `secondary` (bordered), `destructive`, `danger-outline`, `brand` (gradient border, at most one per screen), `link`.
- `size`: `xs` | `sm` | `default` | `md` | `lg`, plus icon-only `icon-xs` | `icon-sm` | `icon` | `icon-lg` (give them `aria-label`). Cosmic variants at `size="default"` render at the `md` height.
- `asChild`: render the styles on a child `<a>`.
- Icons (lucide-react) go inside as children and size themselves.

```tsx
<div className="flex gap-2">
  <Button variant="outline" size="sm">Huỷ</Button>
  <Button size="sm"><Plus />Tạo task</Button>
</div>
```
