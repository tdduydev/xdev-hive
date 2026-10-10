---
category: Data display
---
# StatTile

A cosmic metric tile: small label, a large tabular number, an optional detail line. Use it in a grid of 2–4 for a dashboard's key numbers; for a strip of numbers that link to their lists, use `SummaryStrip`.

**Key props**: `label`, `value` (a node), `detail?`.

```tsx
<div className="grid grid-cols-3 gap-4">
  <StatTile label="Task đang chạy" value="12" detail="3 chờ review" />
  <StatTile label="Lượt chạy hôm nay" value="148" detail="96% thành công" />
  <StatTile label="Chi phí tuần" value="$42,80" />
</div>
```
