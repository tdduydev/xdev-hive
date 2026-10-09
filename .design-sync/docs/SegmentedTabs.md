---
category: Navigation
---
# SegmentedTabs

The cosmic segmented control: pressed buttons on a sunken track for choosing a filter or a view. It implies no tab panels, so it suits filters (Tất cả / Đang chạy / Lỗi). It is controlled.

**Key props**: `label` (accessible name), `items`: `{ value, label, disabled? }[]`, `value`, `onChange(value)`.

```tsx
<SegmentedTabs
  label="Lọc lượt chạy"
  value="running"
  onChange={setFilter}
  items={[{ value: "all", label: "Tất cả" }, { value: "running", label: "Đang chạy" }, { value: "failed", label: "Lỗi" }]}
/>
```
