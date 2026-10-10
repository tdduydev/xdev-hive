---
category: Feedback
---
# Alert

The bordered, tinted message box underneath `Notice` and `ErrorNote`. Use it directly only when neither fits; an icon placed as the first child is aligned automatically.

**Composition**: `Alert` > optional lucide icon, `AlertTitle`, `AlertDescription`.

**Key props**: `variant`: `default` (info blue) | `destructive` (danger red).

```tsx
<Alert>
  <Info />
  <AlertTitle>Hub đang cập nhật</AlertTitle>
  <AlertDescription>Các máy sẽ tự kết nối lại sau khoảng một phút.</AlertDescription>
</Alert>
```
