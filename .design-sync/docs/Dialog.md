---
category: Overlays
---
# Dialog

A modal window for a short task in the current context: create a task, edit a setting, show a run's details. Use `AlertDialog` to confirm a destructive action and `Sheet` for a long panel from the edge. Below 768px wide the dialog fills the screen.

**Composition**: `Dialog` > `DialogTrigger asChild` (a `Button`) + `DialogContent` > `DialogHeader` (`DialogTitle`, `DialogDescription`), the body, then `DialogFooter` (actions on the right, `DialogClose asChild` around the cancel button). `DialogContent` portals to `<body>` with its own overlay; `DialogPortal` / `DialogOverlay` are only needed for custom layouts.

**Key props**: `Dialog` `open` / `defaultOpen` / `onOpenChange`; `DialogContent` `showCloseButton` (default true, the × at top right), `className` to widen it (default `sm:max-w-[480px]`); `DialogFooter` `showCloseButton` adds an outline "Đóng" button.

```tsx
<Dialog>
  <DialogTrigger asChild><Button size="sm">Tạo task</Button></DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Tạo task mới</DialogTitle>
      <DialogDescription>Task vào cột Chưa làm của dự án.</DialogDescription>
    </DialogHeader>
    <Input placeholder="Tiêu đề task" />
    <DialogFooter>
      <DialogClose asChild><Button variant="outline" size="sm">Huỷ</Button></DialogClose>
      <Button size="sm">Tạo task</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```
