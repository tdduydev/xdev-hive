---
category: Overlays
---
# Sheet

A panel that slides in from an edge (Radix Dialog underneath): a task's details beside the board, filters, the mobile navigation drawer.

**Composition**: `Sheet` > `SheetTrigger asChild` + `SheetContent` > `SheetHeader` (`SheetTitle`, `SheetDescription`), the body, `SheetFooter`; `SheetClose asChild` wraps a closing button.

**Key props**: `Sheet` `open` / `defaultOpen` / `onOpenChange`; `SheetContent` `side`: `right` (default) | `left` | `top` | `bottom`, `showCloseButton` (default true); widen it with `className` (e.g. `sm:max-w-lg`).

```tsx
<Sheet>
  <SheetTrigger asChild><Button variant="outline" size="sm">Chi tiết</Button></SheetTrigger>
  <SheetContent>
    <SheetHeader>
      <SheetTitle>R-73a · Runner đẩy ai/* lên remote</SheetTitle>
      <SheetDescription>Chờ review · codex-2</SheetDescription>
    </SheetHeader>
  </SheetContent>
</Sheet>
```
