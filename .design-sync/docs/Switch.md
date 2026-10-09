---
category: Forms
---
# Switch

The Radix on/off switch for a setting that takes effect immediately (an agent's profile on or off, notifications). For the larger cosmic look with a built-in label, use `PrimitiveSwitch`.

**Key props**: `checked` / `defaultChecked` / `onCheckedChange`; `size`: `sm` | `default`; `disabled`; `id` for a `Label`.

```tsx
<div className="flex items-center gap-2">
  <Switch id="auto-dispatch" defaultChecked />
  <Label htmlFor="auto-dispatch">Tự giao task cho máy rảnh</Label>
</div>
```
