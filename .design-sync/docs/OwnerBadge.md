---
category: Data display
---
# OwnerBadge

Who an item belongs to: `owner={null}` means shared by every project and renders the accent "Chung" badge; otherwise the project key in a mono outline badge. Use it on memory entries, docs and skills.

**Key props**: `owner`: `string | null`; `className`.

```tsx
<OwnerBadge owner={null} />
<OwnerBadge owner="xdev-hive" />
```
