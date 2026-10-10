---
category: Overlays
---
# AlertDialog

A blocking confirmation for an action that cannot be undone (remove a machine, delete a task). It has no × and does not close on an outside click: the user must pick an action or cancel.

**Composition**: `AlertDialog` > `AlertDialogTrigger asChild` + `AlertDialogContent` > `AlertDialogHeader` (optional `AlertDialogMedia` with an icon, `AlertDialogTitle`, `AlertDialogDescription`) + `AlertDialogFooter` (`AlertDialogCancel`, `AlertDialogAction`).

**Key props**: `AlertDialogContent` `size`: `default` | `sm`; `AlertDialogAction` / `AlertDialogCancel` take `Button`'s `variant` and `size` (cancel defaults to `outline`; use `variant="destructive"` on a destructive action).

```tsx
<AlertDialog>
  <AlertDialogTrigger asChild><Button variant="danger-outline" size="sm">Gỡ máy</Button></AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogMedia><Trash2 /></AlertDialogMedia>
      <AlertDialogTitle>Gỡ win-qa-02 khỏi hub?</AlertDialogTitle>
      <AlertDialogDescription>Máy sẽ không nhận task nữa. Lịch sử lượt chạy vẫn được giữ.</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Huỷ</AlertDialogCancel>
      <AlertDialogAction variant="destructive">Gỡ máy</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```
