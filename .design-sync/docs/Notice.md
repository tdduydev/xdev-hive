---
category: Feedback
---
# Notice

A tinted message box with the tone's icon: saved, warning, hint. Errors from a failed action use `ErrorNote`.

**Key props**: `tone`: `info` (default) | `ok` | `warn` | `error`; `title?`; `children` (the message); every `<div>` prop.

```tsx
<Notice tone="ok" title="Đã lưu">Cấu hình agent sẽ áp dụng từ lượt chạy tiếp theo.</Notice>
<Notice tone="warn">Máy win-qa-02 đã ngoại tuyến 4 ngày.</Notice>
```
