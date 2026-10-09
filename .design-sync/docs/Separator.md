---
category: Layout
---
# Separator

A 1px divider line (Radix Separator) between groups of content or toolbar items.

**Key props**: `orientation`: `horizontal` (default) | `vertical` (give the parent a height); `decorative` (default true, hidden from assistive technology).

```tsx
<div className="flex h-5 items-center gap-3 text-sm">
  <span>12 task</span>
  <Separator orientation="vertical" />
  <span>3 chờ review</span>
</div>
```
