---
category: Forms
---
# Select

The Radix listbox: a trigger plus a portalled popup. Use it when options need icons or secondary text, or must match the custom look; for plain lists `NativeSelect` is lighter.

**Composition**: `Select` > `SelectTrigger` (holds `SelectValue placeholder`) + `SelectContent` > `SelectItem`s, optionally grouped with `SelectGroup` + `SelectLabel` and split with `SelectSeparator`. Every part must sit inside `Select`.

**Key props**: `Select` `value` / `defaultValue` / `onValueChange`; `SelectTrigger` `size`: `sm` | `default` | `lg`; `SelectItem` `value` (required) and `disabled`.

```tsx
<Select defaultValue="mac-mini-01">
  <SelectTrigger className="w-56"><SelectValue placeholder="Chọn máy" /></SelectTrigger>
  <SelectContent>
    <SelectGroup>
      <SelectLabel>Máy đang trực tuyến</SelectLabel>
      <SelectItem value="mac-mini-01">mac-mini-01</SelectItem>
      <SelectItem value="hc-duytd20-linux">hc-duytd20-linux</SelectItem>
    </SelectGroup>
  </SelectContent>
</Select>
```
