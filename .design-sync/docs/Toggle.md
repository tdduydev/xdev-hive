---
category: Actions
---
# Toggle

A pressed/unpressed button (Radix Toggle) for one on/off view option, such as "show only mine". Use `ToggleGroup` for a set of options and `Switch` for a setting that is saved.

**Key props**
- `variant`: `default` (transparent) | `outline` (bordered).
- `size`: `sm` | `default` | `lg` changes width and padding only. The cosmic theme pins every Toggle to 44px tall (touch target), so `size` does not change the height.
- `pressed` / `defaultPressed` / `onPressedChange`.
- `aria-label` when the content is only an icon.

```tsx
<Toggle variant="outline" size="sm" defaultPressed>Chỉ task của tôi</Toggle>
```
