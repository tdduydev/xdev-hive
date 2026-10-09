---
category: Overlays
---
# Popover

A small non-modal floating panel anchored to a trigger: quick filters, a short form, extra details. For a list of commands use `DropdownMenu`; for a one-line hint use `Tooltip`.

**Composition**: `Popover` > `PopoverTrigger asChild` + `PopoverContent` (optionally `PopoverHeader` with `PopoverTitle` and `PopoverDescription`). `PopoverAnchor` positions it against another element.

**Key props**: `Popover` `open` / `defaultOpen` / `onOpenChange`; `PopoverContent` `align` (`center` default, `start`, `end`), `side`, `sideOffset` (4).

```tsx
<Popover>
  <PopoverTrigger asChild><Button variant="outline" size="sm">Quota</Button></PopoverTrigger>
  <PopoverContent align="start">
    <PopoverHeader>
      <PopoverTitle>claude-1</PopoverTitle>
      <PopoverDescription>Phiên 62% · tuần 35%</PopoverDescription>
    </PopoverHeader>
  </PopoverContent>
</Popover>
```
