---
category: Actions
---
# ToggleGroup

A row of `ToggleGroupItem`s where one (`type="single"`) or several (`type="multiple"`) can be on. With `variant="outline"` it is the design system's segmented control: a sunken track with the selected item raised.

**Key props**
- `type`: `"single"` | `"multiple"` (required); `value` / `defaultValue` / `onValueChange`.
- `variant` and `size` are shared by every item (same values as `Toggle`). Write `variant="default"` explicitly for joined plain buttons: left unset, the items render as separate rounded chips. The app itself uses `variant="outline"`.
- Each `ToggleGroupItem` needs a `value`.

```tsx
<ToggleGroup type="single" variant="outline" size="sm" defaultValue="board">
  <ToggleGroupItem value="board">Bảng</ToggleGroupItem>
  <ToggleGroupItem value="list">Danh sách</ToggleGroupItem>
</ToggleGroup>
```
