---
category: Overlays
---
# DropdownMenu

A menu of actions opened from a button: a row's "more" menu, account menu, sort choices.

**Composition**: `DropdownMenu` > `DropdownMenuTrigger asChild` + `DropdownMenuContent` > `DropdownMenuItem`s, with `DropdownMenuLabel`, `DropdownMenuSeparator`, `DropdownMenuGroup`, `DropdownMenuShortcut` (right-aligned key hint), `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup` + `DropdownMenuRadioItem`, and submenus (`DropdownMenuSub` > `DropdownMenuSubTrigger` + `DropdownMenuSubContent`).

**Key props**: `DropdownMenuContent` `align`, `sideOffset` (6); `DropdownMenuItem` `variant`: `default` | `destructive`, `inset`, `disabled`, `onSelect`.

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="ghost" size="icon-sm" aria-label="Thêm"><MoreHorizontal /></Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuLabel>R-73a</DropdownMenuLabel>
    <DropdownMenuItem>Giao cho máy khác</DropdownMenuItem>
    <DropdownMenuItem>Sao chép link<DropdownMenuShortcut>⌘L</DropdownMenuShortcut></DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive">Xoá task</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```
