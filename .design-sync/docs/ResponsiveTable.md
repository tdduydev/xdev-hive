---
category: Data display
---
# ResponsiveTable

A `Table` that becomes a stack of cards below 768px: each cell gets its column header as a label, and the same rows and controls stay mounted, keeping selection and focus. Use it instead of `Table` on pages that phones open.

**Composition**: `ResponsiveTable` > `TableHeader` (with `TableHead`s, which become the labels) + `TableBody` > `ResponsiveTableRow` > `TableCell`s. A cell with no header label is treated as the row's actions. For CSS-grid lists use `ResponsiveTableFrame` around `ResponsiveGridRow`s (`labels`, `primary` index); `ResponsiveCellLabel` renders one label.

```tsx
<ResponsiveTable>
  <TableHeader>
    <TableRow><TableHead>Task</TableHead><TableHead>Trạng thái</TableHead><TableHead /></TableRow>
  </TableHeader>
  <TableBody>
    <ResponsiveTableRow>
      <TableCell className="font-mono">R-73a</TableCell>
      <TableCell><CommonBadge tone="warn">Chờ review</CommonBadge></TableCell>
      <TableCell><Button variant="outline" size="xs">Mở</Button></TableCell>
    </ResponsiveTableRow>
  </TableBody>
</ResponsiveTable>
```
