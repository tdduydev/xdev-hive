---
category: Forms
---
# Textarea

Multi-line text field with the same look as `Input`. Use it for task descriptions, notes and chat drafts; set `rows` for the starting height.

**Key props**: every native `<textarea>` prop; `aria-invalid` for errors.

```tsx
<Label htmlFor="note">Ghi chú bàn giao</Label>
<Textarea id="note" rows={4} placeholder="Đã làm / chưa làm / cách kiểm tra / rủi ro" />
```
