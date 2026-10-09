---
category: Data display
---
# ListRow

A cosmic list row: a title, an optional description underneath and an action on the right, on a raised surface with a glass ring. Stack them with a small gap for settings lists and integrations.

**Key props**: `title`, `description?`, `action?` (usually a `Button` or `PrimitiveSwitch`).

```tsx
<div className="grid gap-2">
  <ListRow title="GitHub" description="Đẩy branch ai/* và mở PR" action={<Button variant="outline" size="sm">Kết nối</Button>} />
  <ListRow title="Slack" description="Báo khi run xong hoặc lỗi" action={<PrimitiveSwitch defaultChecked />} />
</div>
```
