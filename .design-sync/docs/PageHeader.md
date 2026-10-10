---
category: Layout
---
# PageHeader

The page title row: a 24px display title, an optional subtitle (shown through `PageIntro`, clamped to one line on phones) and actions on the right, with a divider below.

**Key props**: `title`, `subtitle?` (a string), `actions?` (buttons).

```tsx
<PageHeader
  title="Máy chạy agent"
  subtitle="Máy nào đang trực tuyến, chạy phiên bản nào và đang làm gì."
  actions={<Button variant="solid" size="sm">Thêm máy</Button>}
/>
```
