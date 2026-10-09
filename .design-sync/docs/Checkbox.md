---
category: Forms
---
# Checkbox

An 18px Radix checkbox, violet when checked. Use it for options in a form or a permission list and for row selection; for a setting that applies at once, use `Switch`.

**Key props**
- `checked`: `true` | `false` | `"indeterminate"` (a "select all" with some rows picked); `defaultChecked`; `onCheckedChange(value)`.
- `disabled`; `id` to pair with `<Label htmlFor>`.

```tsx
<div className="flex items-center gap-2">
  <Checkbox id="review-after" defaultChecked />
  <Label htmlFor="review-after" className="font-normal">Xong thì review chéo bằng vendor khác</Label>
</div>
```
