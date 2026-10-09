---
category: Data display
---
# Table

The plain semantic table (`<table>` in a horizontally scrolling container). Use it for small static lists that need no search, sort or paging; use `DataTable` for admin lists and `ResponsiveTable` when it must turn into cards on phones.

**Composition**: `Table` > `TableHeader` > `TableRow` > `TableHead`; `TableBody` > `TableRow` > `TableCell`; optional `TableFooter` and `TableCaption`.

```tsx
<Table>
  <TableHeader>
    <TableRow><TableHead>Máy</TableHead><TableHead>Phiên bản</TableHead><TableHead className="text-right">Lượt chạy</TableHead></TableRow>
  </TableHeader>
  <TableBody>
    <TableRow><TableCell>mac-mini-01</TableCell><TableCell className="font-mono">0.138.0</TableCell><TableCell className="text-right">412</TableCell></TableRow>
  </TableBody>
</Table>
```
