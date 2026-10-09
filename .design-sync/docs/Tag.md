---
category: Data display
---
# Tag

The cosmic chip (28px, 12px semibold): filters, labels and quick choices. `active` fills it violet for the selected one.

**Key props**: `active`; every `<span>` prop. `tone` (`neutral` | `info` | `success` | `warning` | `danger`) is written to `data-tone`, but no stylesheet styles it yet, so every tone looks the same: show a coloured status with `CommonBadge` instead.

```tsx
<div className="flex gap-2">
  <Tag active>Tất cả</Tag>
  <Tag>Đang chạy</Tag>
  <Tag>Lỗi</Tag>
</div>
```
