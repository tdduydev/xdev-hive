---
category: Feedback
---
# EmptyState

The cosmic empty state: centred title, a description and an optional action. Use it when a whole page or panel is empty; `Empty` is the lighter box for a single list.

**Key props**: `title`, `description?`, `action?`.

```tsx
<EmptyState
  title="Chưa có dự án"
  description="Tạo dự án đầu tiên để các agent dùng chung memory và task."
  action={<Button variant="solid">Tạo dự án</Button>}
/>
```
