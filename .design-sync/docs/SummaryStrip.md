---
category: Data display
---
# SummaryStrip

One strip of at most 4 numbers at the top of a dashboard page; each number links to the list it counts. Only an abnormal number gets a tone, so a calm page stays calm. Items beyond the fourth are dropped.

**Key props**: `label` (the nav's accessible name); `items`: `{ id, label, value, sub?, href, tone?: "warning" | "danger" }[]`.

```tsx
<SummaryStrip
  label="Tổng quan dự án"
  items={[
    { id: "doing", label: "Đang làm", value: 7, href: "#/board?status=doing" },
    { id: "review", label: "Chờ review", value: 3, sub: "lâu nhất 2 giờ", href: "#/board?status=review" },
    { id: "blocked", label: "Bị chặn", value: 1, tone: "danger", href: "#/board?status=blocked" },
  ]}
/>
```
