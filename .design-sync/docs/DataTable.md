---
category: Data display
---
# DataTable

The admin data table: search box, filter selects, comfortable/compact density, sortable columns, a checkbox column with a bulk-action bar, and paging (25/50/100/200 rows per page). It works on the `rows` it is given; nothing is fetched. Its toolbar and footer text are Vietnamese by default (the app's language).

**Key props**
- `rows`, `rowKey(row)`, `noun` (what a row is, used in "Tìm trong 12 máy…", "1–50 trong 128 lượt chạy").
- `columns`: `{ key, label, width (a CSS grid track: "96px", "minmax(220px,1fr)"), render(row), sub?(row) (second line), align?: "right", mono?, strong?, sortValue?(row) (makes it sortable), title?(row) }[]`.
- `searchText(row)` turns on the search box; `filters`: `{ key, label, value(row), options? }[]`.
- `bulk`: `{ id, label, danger? }[]` plus `onBulk(id, rows)`; `onRowClick`, `selectedKey` (highlighted row), `dim(row)`.
- `minWidth` (720), `maxHeight` ("62vh"), `toolbar` (extra controls), `responsive` (cards under 768px).

```tsx
<DataTable
  rows={tasks}
  rowKey={(t) => t.id}
  noun="task"
  columns={[
    { key: "id", label: "Task", width: "120px", mono: true, render: (t) => t.id, sortValue: (t) => t.id },
    { key: "title", label: "Tiêu đề", width: "minmax(240px,1fr)", strong: true, render: (t) => t.title, sub: (t) => t.project },
    { key: "status", label: "Trạng thái", width: "120px", render: (t) => <CommonBadge tone={STATUS_TONE[t.status]}>{t.statusLabel}</CommonBadge> },
  ]}
  searchText={(t) => `${t.id} ${t.title}`}
  filters={[{ key: "project", label: "Dự án", value: (t) => t.project }]}
/>
```
