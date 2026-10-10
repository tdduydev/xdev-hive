---
category: Forms
---
# PrimitiveSwitch

The cosmic switch (primitives.tsx `Switch`, renamed here because ui/switch owns that name): a native checkbox with `role="switch"`, 44×26px, its label as `children`. Use it in cosmic-style settings panels; it submits with a form like any checkbox.

**Key props**: `children` (the label); `checked` / `defaultChecked` / `onChange`; `disabled`; `name`.

```tsx
<PrimitiveSwitch defaultChecked>Nhận thông báo khi run xong</PrimitiveSwitch>
```
