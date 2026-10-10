---
category: Data display
---
# CommonBadge

The status badge used across pages (common.tsx `Badge`, renamed here because ui/badge owns that name): a tinted background with matching text, readable in light and dark. Pick the tone from what the state means; `STATUS_TONE` maps task, run, proposal and role statuses to tones.

**Key props**: `tone`: `ok` | `warn` | `info` | `running` | `danger` | `accent` | `neutral` (default); `children` (the label); `className`.

```tsx
<CommonBadge tone="ok">Xong</CommonBadge>
<CommonBadge tone={STATUS_TONE["review"]}>Chờ review</CommonBadge>
<CommonBadge tone="danger">Bị chặn</CommonBadge>
```
